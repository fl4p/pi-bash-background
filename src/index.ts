/**
 * pi-bash-background — run shell commands detached and get woken when they
 * produce output or finish. Brings Claude Code's `Bash(run_in_background)`
 * semantic (and a per-line `monitor`) to the Pi coding agent, which otherwise
 * has no background-bash support (Pi's stance is "use tmux").
 *
 * Tools registered:
 *   bash_background({ command, description? }) — detached; wake ONCE on exit.
 *   monitor({ command, description? })         — detached; wake on NEW output
 *                                                (coalesced into batches).
 *   background_stop({ id })                    — tree-kill a job; no wake.
 *   background_list()                          — list live jobs.
 *
 * The wake is `pi.sendUserMessage(...)`, which "always triggers a turn". We use
 * the session-bound `pi` handle (NOT a captured execute-ctx) so the wake follows
 * the active session instead of throwing on a stale ctx after fork/reload.
 *
 * Install:  pi -e /path/to/pi-bash-background/src/index.ts
 *   or symlink src/index.ts into ~/.pi/agent/extensions/ (see README).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Kind = "background" | "monitor";

interface Job {
	id: string;
	kind: Kind;
	description: string;
	command: string;
	logpath: string;
	child: ChildProcess;
	stopped: boolean; // user stopped it intentionally -> suppress wakes
	done: boolean; // dedup: error+exit can both fire -> finish at most once
	// monitor-only state:
	logfd?: number;
	pending?: string[]; // complete lines not yet delivered
	pendingBytes?: number;
	carry?: string; // partial trailing line across chunks
	truncated?: boolean; // pending was capped since last flush
	flushTimer?: ReturnType<typeof setInterval>;
}

// monitor: how often to deliver accumulated new output, and how much to keep
// per batch (so a chatty process can't flood a single turn).
const MONITOR_FLUSH_MS = 1500;
const MONITOR_MAX_PENDING_BYTES = 8_000;

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	let seq = 0;

	// Track streaming state ourselves: ExtensionAPI has no isIdle(), and the
	// wake must pick the right delivery mode at fire time.
	let streaming = false;
	pi.on("agent_start", () => {
		streaming = true;
	});
	pi.on("agent_end", () => {
		streaming = false;
	});

	function wake(text: string) {
		// Always triggers a turn when idle; while streaming, queue as a follow-up
		// so a wake never truncates the in-flight turn. Stay non-fatal — a failed
		// wake (e.g. session mid-teardown) must not crash the watcher.
		try {
			if (streaming) pi.sendUserMessage(text, { deliverAs: "followUp" });
			else pi.sendUserMessage(text);
		} catch {
			/* drop */
		}
	}

	function killTree(child: ChildProcess) {
		if (child.pid === undefined) return;
		// detached:true => child leads its own process group, so -pid hits the
		// whole tree. SIGTERM first, SIGKILL backstop for ignorers.
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			/* already gone */
		}
		setTimeout(() => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				/* already gone */
			}
		}, 2000).unref();
	}

	function newId() {
		return `bg-${seq++}`;
	}

	function logpathFor(id: string) {
		return join(tmpdir(), `pi-${id}-${Date.now()}.log`);
	}

	// ---- monitor line handling --------------------------------------------

	function ingest(job: Job, chunk: Buffer) {
		if (job.logfd !== undefined) {
			try {
				writeSync(job.logfd, chunk);
			} catch {
				/* logfile gone; keep streaming to the model anyway */
			}
		}
		const text = (job.carry ?? "") + chunk.toString("utf8");
		const parts = text.split("\n");
		job.carry = parts.pop() ?? ""; // last element is the partial trailing line
		for (const line of parts) {
			const pending = job.pending!;
			if ((job.pendingBytes ?? 0) + line.length > MONITOR_MAX_PENDING_BYTES) {
				job.truncated = true;
				continue; // drop oldest-style: keep batch bounded
			}
			pending.push(line);
			job.pendingBytes = (job.pendingBytes ?? 0) + line.length + 1;
		}
	}

	function flush(job: Job) {
		const pending = job.pending!;
		if (pending.length === 0 && !job.truncated) return;
		const body = pending.join("\n");
		pending.length = 0;
		job.pendingBytes = 0;
		const note = job.truncated ? "\n(some lines dropped this batch — Read the logfile for full output)" : "";
		job.truncated = false;
		wake(`[monitor:${job.description}] (${job.id}) new output:\n${body}${note}`);
	}

	function finish(job: Job, text: string) {
		if (job.done) return;
		job.done = true;
		if (job.flushTimer) clearInterval(job.flushTimer);
		if (job.logfd !== undefined) {
			try {
				closeSync(job.logfd);
			} catch {
				/* ignore */
			}
		}
		jobs.delete(job.id);
		if (!job.stopped) wake(text);
	}

	function exitClause(code: number | null, signal: NodeJS.Signals | null) {
		return code !== null ? `exited with code ${code}` : `terminated by signal ${signal ?? "unknown"}`;
	}

	// ---- bash_background ----------------------------------------------------

	const bashBackground = defineTool({
		name: "bash_background",
		label: "Bash (background)",
		description:
			"Run a shell command detached and return immediately. Combined stdout+stderr is captured " +
			"to a logfile you can Read anytime. You are notified exactly once when the command exits " +
			"(with its exit code). Use this for long jobs (builds, test runs, servers) where you want " +
			"to keep working and be told when it finishes.",
		promptSnippet: "bash_background({command, description}): run a command detached; get notified once on exit.",
		promptGuidelines: [
			"Prefer plain `bash` for short commands — only use bash_background when the command is long-running.",
			"Do NOT sleep-and-poll a logfile to wait for completion; bash_background wakes you on exit automatically.",
			"Use `monitor` instead when you need to react to output as it streams (an event per line), not just on exit.",
			"Read the returned logpath to inspect progress or results at any time.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run in the background." }),
			description: Type.Optional(
				Type.String({ description: "Short human-readable label (shown in the exit notification)." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const id = newId();
			const description = params.description?.trim() || params.command.slice(0, 60);
			const logpath = logpathFor(id);

			let logfd: number;
			try {
				logfd = openSync(logpath, "w");
			} catch (err) {
				return errorResult(id, `Failed to open logfile ${logpath}: ${String(err)}`);
			}

			let child: ChildProcess;
			try {
				child = spawn(process.env.SHELL || "/bin/sh", ["-c", params.command], {
					cwd: ctx.cwd,
					env: process.env,
					detached: true,
					stdio: ["ignore", logfd, logfd], // stdout+stderr -> logfile
				});
			} catch (err) {
				closeSync(logfd);
				return errorResult(id, `Failed to spawn: ${String(err)}`);
			}
			closeSync(logfd); // child has its own dup'd descriptor now

			const job: Job = {
				id,
				kind: "background",
				description,
				command: params.command,
				logpath,
				child,
				stopped: false,
				done: false,
			};
			jobs.set(id, job);

			child.on("error", (err) => finish(job, `[bash_background:${description}] (${id}) failed to run: ${String(err)}.`));
			child.on("exit", (code, signal) =>
				finish(
					job,
					`[bash_background:${description}] (${id}) ${exitClause(code, signal)}. ` +
						`Combined output is in ${logpath} — Read it to see the results.`,
				),
			);

			return armedResult(id, child.pid, logpath, description, "exits");
		},
	});

	// ---- monitor ------------------------------------------------------------

	const monitor = defineTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Run a shell command detached and be woken as it produces NEW output (delivered in batches, " +
			"not one turn per line). Combined stdout+stderr is also captured to a logfile. Use this to " +
			"watch a streaming process — a dev server, a tail, a long log — where you want to react to " +
			"output as it appears. For a one-shot 'tell me when it's done', use bash_background instead.",
		promptSnippet: "monitor({command, description}): run a command detached; get woken on new output (batched).",
		promptGuidelines: [
			"Use monitor when you must react to streaming output; use bash_background when you only care about the exit.",
			"Do NOT sleep-and-poll; monitor wakes you when there is new output and once more on exit.",
			"Output is delivered in batches and capped per batch — Read the logpath for the complete stream.",
			"Stop a monitor with background_stop({id}) when you no longer need it.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run and monitor." }),
			description: Type.Optional(Type.String({ description: "Short human-readable label (shown in notifications)." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const id = newId();
			const description = params.description?.trim() || params.command.slice(0, 60);
			const logpath = logpathFor(id);

			let logfd: number;
			try {
				logfd = openSync(logpath, "w");
			} catch (err) {
				return errorResult(id, `Failed to open logfile ${logpath}: ${String(err)}`);
			}

			let child: ChildProcess;
			try {
				child = spawn(process.env.SHELL || "/bin/sh", ["-c", params.command], {
					cwd: ctx.cwd,
					env: process.env,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"], // capture lines ourselves
				});
			} catch (err) {
				closeSync(logfd);
				return errorResult(id, `Failed to spawn: ${String(err)}`);
			}

			const job: Job = {
				id,
				kind: "monitor",
				description,
				command: params.command,
				logpath,
				child,
				stopped: false,
				done: false,
				logfd,
				pending: [],
				pendingBytes: 0,
				carry: "",
				truncated: false,
			};
			jobs.set(id, job);

			child.stdout?.on("data", (c: Buffer) => ingest(job, c));
			child.stderr?.on("data", (c: Buffer) => ingest(job, c));
			job.flushTimer = setInterval(() => flush(job), MONITOR_FLUSH_MS);

			child.on("error", (err) => finish(job, `[monitor:${description}] (${id}) failed to run: ${String(err)}.`));
			child.on("exit", (code, signal) => {
				// Drain any trailing partial line, deliver the last batch, and the
				// exit notice — all in the single final wake.
				if (job.carry && job.carry.length > 0) {
					job.pending!.push(job.carry);
					job.carry = "";
				}
				const tail = job.pending!.length > 0 ? `\nFinal output:\n${job.pending!.join("\n")}` : "";
				job.pending!.length = 0;
				finish(
					job,
					`[monitor:${description}] (${id}) ${exitClause(code, signal)}. Full output in ${logpath}.${tail}`,
				);
			});

			return armedResult(id, child.pid, logpath, description, "produces output or exits");
		},
	});

	// ---- background_stop ----------------------------------------------------

	const backgroundStop = defineTool({
		name: "background_stop",
		label: "Stop background job",
		description: "Tree-kill a running bash_background or monitor job by id. No notification is sent (the stop is intentional).",
		parameters: Type.Object({
			id: Type.String({ description: "The job id returned by bash_background/monitor (e.g. bg-0)." }),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const job = jobs.get(params.id);
			if (!job) {
				return {
					content: [{ type: "text", text: `No live job with id ${params.id}.` }],
					details: { id: params.id, stopped: false },
				};
			}
			job.stopped = true;
			if (job.flushTimer) clearInterval(job.flushTimer);
			if (job.logfd !== undefined) {
				try {
					closeSync(job.logfd);
				} catch {
					/* ignore */
				}
			}
			killTree(job.child);
			jobs.delete(params.id);
			return {
				content: [
					{ type: "text", text: `Stopped ${params.id} ("${job.description}"). Output remains in ${job.logpath}.` },
				],
				details: { id: params.id, stopped: true, logpath: job.logpath },
			};
		},
	});

	// ---- background_list ----------------------------------------------------

	const backgroundList = defineTool({
		name: "background_list",
		label: "List background jobs",
		description: "List the currently running bash_background and monitor jobs (id, kind, pid, logfile).",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const live = [...jobs.values()];
			if (live.length === 0) {
				return { content: [{ type: "text", text: "No background jobs running." }], details: { jobs: [] } };
			}
			const lines = live.map((j) => `${j.id}  [${j.kind}]  pid ${j.child.pid}  "${j.description}"  -> ${j.logpath}`);
			return {
				content: [{ type: "text", text: `Running jobs:\n${lines.join("\n")}` }],
				details: {
					jobs: live.map((j) => ({
						id: j.id,
						kind: j.kind,
						pid: j.child.pid,
						description: j.description,
						logpath: j.logpath,
					})),
				},
			};
		},
	});

	// ---- shared result builders --------------------------------------------

	function errorResult(id: string, message: string) {
		return { content: [{ type: "text" as const, text: message }], details: { id, error: true } };
	}

	function armedResult(id: string, pid: number | undefined, logpath: string, description: string, wakeWhen: string) {
		return {
			content: [
				{
					type: "text" as const,
					text:
						`Job armed: ${id} ("${description}"). PID ${pid}. Output streaming to ${logpath}. ` +
						`You'll be notified when it ${wakeWhen}; Read the logfile anytime to check progress.`,
				},
			],
			details: { id, pid, logpath },
		};
	}

	pi.registerTool(bashBackground);
	pi.registerTool(monitor);
	pi.registerTool(backgroundStop);
	pi.registerTool(backgroundList);

	// Best-effort cleanup so we never leak detached process groups.
	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) {
			job.stopped = true;
			if (job.flushTimer) clearInterval(job.flushTimer);
			killTree(job.child);
		}
		jobs.clear();
	});
}
