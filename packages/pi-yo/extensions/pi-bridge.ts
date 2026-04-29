/**
 * pi-bridge: Inter-Session Messaging Extension
 *
 * Enables bidirectional messaging between Pi sessions running in separate terminals.
 * Both the human user and the AI can send and receive messages across sessions.
 *
 * How it works:
 *   - Each session starts a Unix domain socket server at ~/.pi/agent/ipc/<pid>.sock
 *   - Sessions register themselves in ~/.pi/agent/ipc/registry.json for discovery
 *   - Messages are JSON lines sent over the socket connection
 *
 * Commands (for the human):
 *   /bridge-list                        - List all discoverable Pi sessions
 *   /bridge-visibility status|invisible|visible
 *                                      - Show or set this session's discovery visibility
 *   /bridge-send <name-or-id> <message> - Send a message to another session
 *   /bridge-ping <name-or-id>           - Ping another session to check it's alive
 *   /yo -<target> -<source> -<behavior> <message>
 *                                      - Shorthand send via canonical roster aliases
 *
 * LLM Tools (Claude can use these autonomously):
 *   list_sessions           - Discover available Pi sessions
 *   set_session_visibility  - Hide or reveal this Pi session in discovery
 *   send_to_session         - Send a message to another session
 *
 * Session names:
 *   By default each session is identified by its working directory basename.
 *   If you run /name in pi, that name is used instead.
 *   You can match sessions by: PID, session name, or CWD basename.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Type } from "typebox";

const bridgeCore = require("../lib/pi-bridge-core.js") as any;

// ─── Paths ───────────────────────────────────────────────────────────────────

const IPC_DIR = bridgeCore.DEFAULT_PATHS.ipcDir;
const REGISTRY_FILE = bridgeCore.DEFAULT_PATHS.registryFile;
const BRIDGE_ROSTER_FILE = path.join(os.homedir(), ".pi", "agent", "bridge-roster.json");
const BRIDGE_POLICY_FILE = path.join(os.homedir(), ".pi", "agent", "bridge-policy.json");
const TOOL_USAGE_FILE = path.join(os.homedir(), ".pi", "agent", "tool-usage.jsonl");

// ─── Types ───────────────────────────────────────────────────────────────────

interface RegistryEntry {
	pid: number;
	name: string; // display name (session name or cwd basename)
	cwd: string;
	socketPath: string;
	startedAt: number;
	bridgeVisibility?: "visible" | "invisible";
	// Supacode context (present when running inside Supacode)
	supacodeTabId?: string;
	supacodeWorktreeId?: string; // percent-encoded
	supacodeSurfaceId?: string;
}

interface Registry {
	sessions: RegistryEntry[];
}

interface BridgeRosterTarget {
	role: string;
	name?: string;
	cwd?: string;
	pid?: number;
}

interface BridgeRosterBehavior {
	label: string;
	instruction: string;
	isReply: boolean;
}

interface BridgeRoster {
	targets: Record<string, BridgeRosterTarget>;
	sources: Record<string, string>;
	behaviors: Record<string, BridgeRosterBehavior>;
}

interface BridgeMessage {
	protocol?: number;
	id?: string;
	type: "message" | "ping" | "pong" | "ack";
	fromPid: number;
	fromName: string;
	fromCwd: string;
	content: string;
	timestamp: number;
	isReply?: boolean; // true = receiver should NOT auto-reply (prevents loops)
	ackFor?: string;
	ok?: boolean;
}

// ─── Registry Helpers ────────────────────────────────────────────────────────

function ensureIpcDir(): void {
	bridgeCore.ensureIpcDir(IPC_DIR);
}

function readRegistry(): Registry {
	return bridgeCore.readRegistry(REGISTRY_FILE) as Registry;
}

function writeRegistry(registry: Registry): void {
	bridgeCore.writeRegistry(registry, REGISTRY_FILE);
}

function isProcessAlive(pid: number): boolean {
	return bridgeCore.isProcessAlive(pid);
}

function pruneDeadSessions(sessions: RegistryEntry[]): RegistryEntry[] {
	return bridgeCore.pruneDeadSessions(sessions) as RegistryEntry[];
}

function registerSession(entry: RegistryEntry): void {
	bridgeCore.registerSession(entry, REGISTRY_FILE);
}

function unregisterSession(pid: number): void {
	bridgeCore.unregisterSession(pid, REGISTRY_FILE);
}

function visibleSessions(sessions: RegistryEntry[]): RegistryEntry[] {
	return bridgeCore.visibleSessions(sessions) as RegistryEntry[];
}

function getActiveSessions(excludePid?: number, options: { includeInvisible?: boolean } = {}): RegistryEntry[] {
	const sessions = bridgeCore.activeSessions({ registryFile: REGISTRY_FILE, excludePid }) as RegistryEntry[];
	return options.includeInvisible ? sessions : visibleSessions(sessions);
}

function resolveSession(nameOrId: string, excludePid?: number): any {
	const sessions = getActiveSessions(excludePid, { includeInvisible: true });
	return bridgeCore.resolveSessionTarget(nameOrId, sessions);
}

function findSession(nameOrId: string, excludePid?: number): RegistryEntry | undefined {
	const result = resolveSession(nameOrId, excludePid);
	return result.status === "found" ? result.session : undefined;
}

function formatResolutionError(target: string, result: any, sessions: RegistryEntry[]): string {
	const safeTarget = safeText(target, 200);
	if (result.status === "ambiguous") {
		return `Ambiguous session target "${safeTarget}" matched multiple sessions by ${result.matchKind}.\nCandidates:\n  ${bridgeCore.formatCandidateList(result.candidates)}`;
	}
	return `Session "${safeTarget}" not found.\nAvailable:\n  ${bridgeCore.formatCandidateList(sessions)}`;
}

function defaultBridgeRoster(): BridgeRoster {
	return {
		targets: {},
		sources: {
			"0": "current-session",
		},
		behaviors: {
			"0": {
				label: "FYI / no follow-up required",
				instruction: "No reply required unless this is wrong or unsafe.",
				isReply: true,
			},
			"1": {
				label: "stash in docs/memory",
				instruction: "Update relevant tracker/docs/lessons/rules/backlog if applicable, then reply with changed paths.",
				isReply: false,
			},
			"999": {
				label: "URGENT / production issue",
				instruction: "Urgent/prod issue: interrupt current work, ACK quickly, investigate, and reply with status/blockers.",
				isReply: false,
			},
		},
	};
}

function readBridgeRoster(): BridgeRoster {
	const defaults = defaultBridgeRoster();
	try {
		if (!fs.existsSync(BRIDGE_ROSTER_FILE)) {
			bridgeCore.secureWriteFile(BRIDGE_ROSTER_FILE, JSON.stringify(defaults, null, 2));
			return defaults;
		}
		bridgeCore.chmodSafe(BRIDGE_ROSTER_FILE, 0o600);
		const parsed = JSON.parse(fs.readFileSync(BRIDGE_ROSTER_FILE, "utf-8"));
		return {
			targets: { ...defaults.targets, ...(parsed.targets || {}) },
			sources: { ...defaults.sources, ...(parsed.sources || {}) },
			behaviors: { ...defaults.behaviors, ...(parsed.behaviors || {}) },
		};
	} catch {
		return defaults;
	}
}

function splitCommandArgs(input: string): string[] {
	const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	return matches.filter((arg): arg is string => typeof arg === "string").map((arg) => {
		if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
			return arg.slice(1, -1);
		}
		return arg;
	});
}

function parseNumericFlag(token: string | undefined): string | undefined {
	const match = token?.match(/^-([0-9]+)$/);
	return match?.[1];
}

function duplicateCwdWarnings(sessions: RegistryEntry[]): string[] {
	return bridgeCore.duplicateCwdWarnings(sessions);
}

function getSessionVisibility(session: RegistryEntry | undefined): "visible" | "invisible" {
	return bridgeCore.normalizeBridgeVisibility(session?.bridgeVisibility) as "visible" | "invisible";
}

function visibilityStatusLine(visibility: "visible" | "invisible", pid: number): string {
	if (visibility === "invisible") {
		return `Bridge visibility: invisible\nThis session is hidden from normal pi-yo discovery and name/cwd targeting. Exact PID still works: ${pid}.`;
	}
	return "Bridge visibility: visible\nThis session appears in pi-yo discovery and normal target resolution.";
}

function visibilityNotice(session: RegistryEntry): string {
	return getSessionVisibility(session) === "invisible" ? " (invisible; exact PID target)" : "";
}

function chooseCanonicalSession(candidates: RegistryEntry[], target: BridgeRosterTarget): RegistryEntry | undefined {
	if (candidates.length === 0) return undefined;
	if (target.pid) {
		const byPid = candidates.find((s) => s.pid === target.pid);
		if (byPid) return byPid;
	}
	if (target.name) {
		const byExactName = candidates.find((s) => s.name === target.name);
		if (byExactName) return byExactName;
	}
	const nonDuplicateName = candidates.find((s) => !/\(CC\)$/i.test(s.name));
	return nonDuplicateName ?? candidates.sort((a, b) => a.startedAt - b.startedAt)[0];
}

function safeText(value: unknown, maxBytes = 500): string {
	return bridgeCore.sanitizeMetadata(value, maxBytes);
}

function safeSession(session: RegistryEntry): RegistryEntry {
	return bridgeCore.sanitizeSessionForDisplay(session) as RegistryEntry;
}

function notifyCommand(ctx: ExtensionContext, content: string, level: "info" | "warning" | "error" | "success", action?: string): void {
	(ctx.ui.notify as any)(bridgeCore.formatNoticeWithControls(content, { action }), level);
}

function logToolUsage(ctx: any, kind: string, name: string, metadata: Record<string, unknown> = {}): void {
	const now = Date.now();
	let sessionFile: string | undefined;
	try {
		sessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;
	} catch {}
	const event = {
		ts: new Date(now).toISOString(),
		timestamp: now,
		cwd: ctx.cwd,
		sessionFile,
		pid: process.pid,
		kind,
		name,
		source: "pi-bridge",
		metadata,
	};
	try {
		bridgeCore.appendFileSecure(TOOL_USAGE_FILE, JSON.stringify(event) + "\n", {
			maxBytes: bridgeCore.DEFAULT_TOOL_USAGE_MAX_BYTES,
			backups: bridgeCore.DEFAULT_TOOL_USAGE_BACKUPS,
		});
	} catch {}
}

function resolveRosterTarget(alias: string, roster: BridgeRoster, excludePid?: number): { session?: RegistryEntry; target?: BridgeRosterTarget; warning?: string } {
	const target = roster.targets[alias];
	if (!target) return {};

	const allSessions = getActiveSessions(excludePid, { includeInvisible: true });
	const candidates = allSessions.filter((s) => {
		if (target.pid && s.pid === target.pid) return true;
		if (target.name && bridgeCore.isSessionVisible(s) && s.name === target.name) return true;
		if (target.cwd && bridgeCore.isSessionVisible(s) && s.cwd === target.cwd) return true;
		return false;
	});

	const session = chooseCanonicalSession(candidates, target);
	const warning = candidates.length > 1
		? `Multiple sessions match ${safeText(target.role, 200)}; selected ${session ? safeText(session.name, 200) : "unknown"} pid:${session?.pid}.`
		: undefined;
	return { session, target, warning };
}

// ─── Supacode helpers ────────────────────────────────────────────────────────

function maybeFocusSession(session: RegistryEntry): any {
	const policy = bridgeCore.readBridgePolicy(BRIDGE_POLICY_FILE);
	return bridgeCore.maybeFocusSession(session, policy);
}

function focusNotice(focus: any): string {
	if (!focus) return "";
	if (focus.focused) return " Focused target Supacode tab.";
	if (focus.frontmostApp && /not allowed/i.test(String(focus.reason ?? ""))) {
		return ` Focus skipped: frontmost app is ${safeText(focus.frontmostApp, 80)}.`;
	}
	return "";
}

// ─── Socket Transport ────────────────────────────────────────────────────────

async function sendToSocket(socketPath: string, message: BridgeMessage): Promise<any> {
	return bridgeCore.sendToSocket(socketPath, message);
}

function receiptSuffix(receipt: any): string {
	if (receipt?.acked) return " ACK received.";
	return ` Delivered, but ${receipt?.warning ?? "no ACK receipt was returned."}`;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const myPid = process.pid;
	const mySocketPath = path.join(IPC_DIR, `${myPid}.sock`);
	const myMailboxFile = path.join(IPC_DIR, `${myPid}.mailbox`);
	let server: net.Server | undefined;
	let currentCtx: ExtensionContext | undefined;
	let myName = "";
	let rateLimitSize = bridgeCore.DEFAULT_BRIDGE_POLICY.rateLimit.perSenderPer10s;
	let senderRateLimiter = bridgeCore.createSenderRateLimiter({ limit: rateLimitSize, windowMs: 10_000 });

	// Helper to get the display name for this session
	function getMyName(ctx: ExtensionContext): string {
		return pi.getSessionName() ?? path.basename(ctx.cwd);
	}

	function currentRegistryEntry(): RegistryEntry | undefined {
		return readRegistry().sessions.find((session) => session.pid === myPid);
	}

	function setMyVisibility(visibility: "visible" | "invisible"): any {
		return bridgeCore.setSessionVisibility(myPid, visibility, REGISTRY_FILE);
	}

	function readPolicy(): any {
		return bridgeCore.readBridgePolicy(BRIDGE_POLICY_FILE);
	}

	function checkSenderRateLimit(policy: any, msg: BridgeMessage): any {
		const nextLimit = policy?.rateLimit?.perSenderPer10s ?? bridgeCore.DEFAULT_BRIDGE_POLICY.rateLimit.perSenderPer10s;
		if (nextLimit !== rateLimitSize) {
			rateLimitSize = nextLimit;
			senderRateLimiter = bridgeCore.createSenderRateLimiter({ limit: rateLimitSize, windowMs: 10_000 });
		}
		return senderRateLimiter.check(String(msg.fromPid));
	}

	function appendToSessionMailbox(msg: BridgeMessage, reason: string): void {
		const isReply = msg.isReply === true;
		const sender = `${safeText(msg.fromName, 200)} (${path.basename(safeText(msg.fromCwd, 1000))})`;
		const replyLine = isReply
			? `_This is a reply — no further reply needed._`
			: `_Review and reply manually with \`reply_to_session\` if appropriate._`;
		const entry = [
			`---`,
			`📨 From: ${sender}  |  ${new Date(msg.timestamp).toLocaleString()}${isReply ? "  (reply)" : ""}`,
			`Held by policy: ${safeText(reason, 500)}`,
			``,
			msg.content,
			``,
			replyLine,
			``,
		].join("\n");
		bridgeCore.appendFileSecure(myMailboxFile, entry);
	}

	// Handle an incoming message from another session
	function handleIncoming(msg: BridgeMessage, ctx: ExtensionContext): void {
		const sender = `${safeText(msg.fromName, 200)} (${path.basename(safeText(msg.fromCwd, 1000))})`;

		if (msg.type === "ping") {
			ctx.ui.notify(`📡 Ping from ${sender}`, "info");
			return;
		}

		const policy = readPolicy();
		const rate = checkSenderRateLimit(policy, msg);
		const delivery = bridgeCore.decideMessageDelivery(msg, policy, {
			rateLimited: rate.allowed === false,
			rateLimitReason: rate.reason,
		});
		if (delivery.action === "mailbox") {
			appendToSessionMailbox(msg, delivery.reason);
			ctx.ui.notify(`📥 Inter-session message from ${sender} held in bridge mailbox (${delivery.reason}). Run /bridge-mailbox to review.`, "warning");
			return;
		}

		const isReply = msg.isReply === true;

		// Build a clearly labeled message so both the human and Claude see it.
		// For original messages, append a reply instruction so the LLM knows to respond.
		// For replies, just show the content — no further reply expected (prevents loops).
		const replyLine = isReply
			? `_This is a reply — no further reply needed._`
			: `_Please reply to ${safeText(msg.fromName, 200)} using the \`reply_to_session\` tool after processing this message._`;

		const content = [
			`📨 **Inter-session message from ${sender}**${isReply ? " _(reply)_" : ""}`,
			``,
			msg.content,
			``,
			replyLine,
		].join("\n");

		// Inject into the conversation - LLM will see it and can respond
		// Use "followUp" delivery so we don't interrupt mid-tool-call processing
		if (ctx.isIdle()) {
			pi.sendUserMessage(content);
		} else {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		}
	}

	// ── Session Lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		myName = getMyName(ctx);

		ensureIpcDir();
		bridgeCore.doctorIpcPermissions({ fix: true, extraFiles: [BRIDGE_ROSTER_FILE, BRIDGE_POLICY_FILE, TOOL_USAGE_FILE, myMailboxFile] });

		// Remove any stale socket from a previous crashed session on this pid
		try {
			fs.unlinkSync(mySocketPath);
		} catch {}

		// Start the socket server
		server = net.createServer((socket) => {
			let buffer = "";

			socket.on("data", (chunk) => {
				const collected = bridgeCore.collectJsonLines(buffer, chunk.toString("utf-8"));
				if (collected.overflow) {
					socket.destroy();
					return;
				}
				buffer = collected.buffer;

				for (const line of collected.lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const parsed = JSON.parse(trimmed);
						const validation = bridgeCore.validateBridgeMessage(parsed);
						if (!validation.ok) continue;
						const msg = validation.value as BridgeMessage;
						const ctx = currentCtx;
						if (ctx && (msg.type === "message" || msg.type === "ping")) {
							handleIncoming(msg, ctx);
							const responseType = msg.type === "ping" ? "pong" : "ack";
							const response = bridgeCore.createSocketResponse(responseType, msg, {
								fromPid: myPid,
								fromName: myName,
								fromCwd: ctx.cwd,
							});
							socket.write(JSON.stringify(response) + "\n", "utf-8");
						}
					} catch {
						// Malformed message - ignore
					}
				}
			});

			socket.on("error", () => {
				// Ignore socket errors from individual connections
			});
		});

		server.on("error", (err) => {
			currentCtx?.ui.notify(`pi-bridge: socket error: ${err.message}`, "warning");
		});

		await new Promise<void>((resolve) => {
			server!.listen(mySocketPath, resolve);
		});
		bridgeCore.chmodSafe(mySocketPath, 0o600);

		// Register in the shared registry (include Supacode context if available)
		registerSession({
			pid: myPid,
			name: myName,
			cwd: ctx.cwd,
			socketPath: mySocketPath,
			startedAt: Date.now(),
			bridgeVisibility: "visible",
			...(process.env.SUPACODE_TAB_ID && {
				supacodeTabId: process.env.SUPACODE_TAB_ID,
				supacodeWorktreeId: process.env.SUPACODE_WORKTREE_ID,
				supacodeSurfaceId: process.env.SUPACODE_SURFACE_ID,
			}),
		});

		if (ctx.hasUI) {
			const sessions = getActiveSessions(myPid);
			const others = sessions.length;
			const extra = others > 0 ? ` (${others} other session${others > 1 ? "s" : ""} available)` : "";
			ctx.ui.notify(`📡 pi-bridge ready — you are "${myName}"${extra}`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		unregisterSession(myPid);
		server?.close();
		try {
			fs.unlinkSync(mySocketPath);
		} catch {}
	});

	// Keep name in sync if the user renames the session mid-session
	pi.on("agent_end", async (_event, ctx) => {
		const newName = getMyName(ctx);
		if (newName !== myName) {
			myName = newName;
			// Update registry entry
			const registry = readRegistry();
			const entry = registry.sessions.find((s) => s.pid === myPid);
			if (entry) {
				entry.name = myName;
				writeRegistry(registry);
			}
		}
	});

	// ── Commands (human-facing) ────────────────────────────────────────────

	pi.registerCommand("bridge-visibility", {
		description: "Show or set this Pi session's bridge visibility (usage: /bridge-visibility status|invisible|visible)",
		handler: async (args, ctx) => {
			logToolUsage(ctx, "slash_command", "bridge-visibility", { hasArgs: Boolean(args.trim()) });
			const action = args.trim().toLowerCase() || "status";

			if (action === "status") {
				const visibility = getSessionVisibility(currentRegistryEntry());
				notifyCommand(ctx, visibilityStatusLine(visibility, myPid), "info", "Use /bridge-visibility invisible or /bridge-visibility visible to change it.");
				return;
			}

			if (action !== "visible" && action !== "invisible") {
				notifyCommand(ctx, "Usage: /bridge-visibility status|invisible|visible", "warning", "This command only changes the current Pi session.");
				return;
			}

			const result = setMyVisibility(action as "visible" | "invisible");
			const level = result.updated ? "success" : "warning";
			const footer = result.updated ? "This only affects the current Pi session." : "Session was not found in the registry; try /reload if this persists.";
			notifyCommand(ctx, visibilityStatusLine(action as "visible" | "invisible", myPid), level, footer);
		},
	});

	pi.registerCommand("bridge-list", {
		description: "List all discoverable Pi sessions",
		handler: async (_args, ctx) => {
			logToolUsage(ctx, "slash_command", "bridge-list");
			const registry = readRegistry();
			const sessions = visibleSessions(pruneDeadSessions(registry.sessions));

			if (sessions.length === 0) {
				notifyCommand(ctx, "No Pi sessions found.", "info", "Start or reload another Pi session, then run /bridge-list again.");
				return;
			}

			const lines = sessions.map((rawSession) => {
				const s      = safeSession(rawSession);
				const age    = Math.round((Date.now() - rawSession.startedAt) / 60000);
				const isMe   = rawSession.pid === myPid;
				const bullet  = isMe ? "▶" : "•";
				const tag     = isMe ? "  ← you" : "";
				const sc      = s.supacodeTabId ? `  [💻 tab:${s.supacodeTabId.slice(0, 8)}]` : "";
				return `  ${bullet} ${s.name}  [pid:${rawSession.pid}]  ${s.cwd}  (${age}m ago)${sc}${tag}`;
			});

			const duplicates = duplicateCwdWarnings(sessions);
			const duplicateBlock = duplicates.length > 0
				? `\n\n⚠️ Duplicate cwd sessions detected — target canonical PID/name explicitly:\n${duplicates.map((d) => `  - ${d}`).join("\n")}`
				: "";
			notifyCommand(ctx, `Active Pi sessions:\n${lines.join("\n")}${duplicateBlock}`, "info", "Use /bridge-send <target> <message>, /bridge-ping <target>, or /yo list.");
		},
	});

	pi.registerCommand("bridge-mailbox", {
		description: "Review inter-session messages held by bridge policy, then clear the mailbox",
		handler: async (_args, ctx) => {
			logToolUsage(ctx, "slash_command", "bridge-mailbox");
			try {
				const content = bridgeCore.readAndClearFileAtomic(myMailboxFile).trim();
				ctx.ui.notify(bridgeCore.formatMailboxNotice(content), "info");
			} catch (err) {
				notifyCommand(ctx, `Failed to read bridge mailbox: ${err}`, "error", "Fix the mailbox error, then run /bridge-mailbox again.");
			}
		},
	});

	pi.registerCommand("bridge-send", {
		description: 'Send a message to another Pi session (usage: /bridge-send <name-or-pid> <message>)',
		handler: async (args, ctx) => {
			logToolUsage(ctx, "slash_command", "bridge-send", { hasArgs: Boolean(args.trim()) });
			const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!match) {
				notifyCommand(ctx, "Usage: /bridge-send <name-or-pid> <message>", "warning", "Run /bridge-list to find session names and PIDs.");
				return;
			}

			const [, target, content] = match;
			const resolution = resolveSession(target, myPid);

			if (resolution.status !== "found") {
				notifyCommand(ctx, formatResolutionError(target, resolution, getActiveSessions(myPid)), "error", "Use an exact name or PID from /bridge-list.");
				return;
			}
			const session = resolution.session as RegistryEntry;

			const msg: BridgeMessage = {
				type: "message",
				fromPid: myPid,
				fromName: myName,
				fromCwd: ctx.cwd,
				content,
				timestamp: Date.now(),
				isReply: false,
			};

			try {
				const receipt = await sendToSocket(session.socketPath, msg);
				const focus = maybeFocusSession(session);
				const safe = safeSession(session);
				notifyCommand(
					ctx,
					`✉️  Sent to "${safe.name}"${visibilityNotice(session)}.${focusNotice(focus)}${receiptSuffix(receipt)}`,
					receipt.acked ? "success" : "warning",
					"Transport ACK only means the recipient process accepted the message.",
				);
			} catch (err) {
				notifyCommand(ctx, `Failed to send to "${safeSession(session).name}": ${err}`, "error", "Run /bridge-ping <target> or /bridge-list to check the recipient.");
			}
		},
	});

	pi.registerCommand("yo", {
		description: "Shorthand bridge send (usage: /yo -<target> [-<source>] [-<behavior>] <message>; /yo list)",
		handler: async (args = "", ctx) => {
			logToolUsage(ctx, "slash_command", "yo", { hasArgs: Boolean(args.trim()) });
			const tokens = splitCommandArgs(args.trim());
			const roster = readBridgeRoster();

			if (tokens.length === 0 || tokens[0] === "list" || tokens[0] === "--list") {
				const targetLines = Object.entries(roster.targets)
					.sort(([a], [b]) => Number(a) - Number(b))
					.map(([key, value]) => `  -${key}: ${safeText(value.role, 200)} (${value.name ? safeText(value.name, 200) : "any name"}${value.cwd ? `, ${safeText(value.cwd, 500)}` : ""})`);
				const sourceLines = Object.entries(roster.sources)
					.sort(([a], [b]) => Number(a) - Number(b))
					.map(([key, value]) => `  -${key}: ${safeText(value, 200)}`);
				const behaviorLines = Object.entries(roster.behaviors)
					.sort(([a], [b]) => Number(a) - Number(b))
					.map(([key, value]) => `  -${key}: ${safeText(value.label, 200)}`);
				notifyCommand(ctx, [
					"/yo shorthand roster",
					"",
					"Targets:",
					...targetLines,
					"",
					"Sources/follow-up identity:",
					...sourceLines,
					"",
					"Behaviors:",
					...behaviorLines,
					"",
					"Example: /yo -1 -2 -999 prod checkout leak — please investigate",
					`Config: ${BRIDGE_ROSTER_FILE}`,
				].join("\n"), "info", "Use /yo -<target> [-<source>] [-<behavior>] <message> to send.");
				return;
			}

			const targetAlias = parseNumericFlag(tokens.shift()) ?? "";
			if (!targetAlias) {
				notifyCommand(ctx, "Usage: /yo -<target> [-<source>] [-<behavior>] <message>  (try /yo list)", "warning", "Run /yo list to see configured target, source, and behavior aliases.");
				return;
			}

			let sourceAlias = "0";
			let behaviorAlias = "0";

			const maybeSource = parseNumericFlag(tokens[0]);
			if (maybeSource) {
				sourceAlias = maybeSource;
				tokens.shift();
			}
			const maybeBehavior = parseNumericFlag(tokens[0]);
			if (maybeBehavior) {
				behaviorAlias = maybeBehavior;
				tokens.shift();
			}

			const content = tokens.join(" ").trim();
			if (!content) {
				notifyCommand(ctx, "/yo needs a message body. Example: /yo -1 -2 -999 prod issue details", "warning", "Run /yo list to inspect aliases before sending.");
				return;
			}

			const { session, target, warning } = resolveRosterTarget(targetAlias, roster, myPid);
			if (!session || !target) {
				const available = getActiveSessions(myPid)
					.map((rawSession) => {
						const s = safeSession(rawSession);
						return `"${s.name}" pid:${rawSession.pid} cwd:${s.cwd}`;
					})
					.join("\n  ");
				notifyCommand(ctx, `No active session found for /yo target -${safeText(targetAlias, 50)}.\nAvailable:\n  ${available || "(none)"}\nConfig: ${BRIDGE_ROSTER_FILE}`, "error", "Run /bridge-list to see active sessions or update the bridge roster config.");
				return;
			}

			const behavior = roster.behaviors[behaviorAlias] ?? roster.behaviors["0"];
			const sourceLabel = roster.sources[sourceAlias] ?? `alias -${sourceAlias}`;
			const decorated = [
				`[yo:${behaviorAlias}] ${behavior.label}`,
				`Target: ${safeText(target.role, 200)} (-${safeText(targetAlias, 50)})`,
				`From/follow-up identity: ${safeText(sourceLabel, 200)} (-${safeText(sourceAlias, 50)})`,
				`Sent from session: ${safeText(myName, 200)} pid:${myPid} cwd:${safeText(ctx.cwd, 1000)}`,
				`Instruction: ${safeText(behavior.instruction, 1000)}`,
				"",
				content,
			].join("\n");

			const msg: BridgeMessage = {
				type: "message",
				fromPid: myPid,
				fromName: myName,
				fromCwd: ctx.cwd,
				content: decorated,
				timestamp: Date.now(),
				isReply: behavior.isReply,
			};

			try {
				const receipt = await sendToSocket(session.socketPath, msg);
				const focus = maybeFocusSession(session);
				const safe = safeSession(session);
				notifyCommand(ctx, [
					`✉️  /yo delivered to ${safeText(target.role, 200)} (${safe.name} pid:${session.pid})${visibilityNotice(session)}.`,
					receipt.acked ? "Transport ACK received from recipient process." : receipt.warning,
					behavior.isReply ? "No reply requested." : "Agent reply/ACK still depends on recipient behavior.",
					focusNotice(focus),
					warning ? `Warning: ${warning}` : "",
					"Delivery receipt is not the same as human/agent completion.",
				].filter(Boolean).join("\n"), receipt.acked ? "success" : "warning", "Use /bridge-mailbox to review held inbound messages.");
			} catch (err) {
				notifyCommand(ctx, `Failed to /yo ${safeText(target.role, 200)} (${safeSession(session).name}): ${err}`, "error", "Run /bridge-ping <target> or /bridge-list to check the recipient.");
			}
		},
	});

	pi.registerCommand("bridge-ping", {
		description: "Ping another Pi session to verify it is alive (usage: /bridge-ping <name-or-pid>)",
		handler: async (args, ctx) => {
			logToolUsage(ctx, "slash_command", "bridge-ping", { hasArgs: Boolean(args.trim()) });
			const target = args.trim();
			if (!target) {
				notifyCommand(ctx, "Usage: /bridge-ping <name-or-pid>", "warning", "Run /bridge-list to find session names and PIDs.");
				return;
			}

			const resolution = resolveSession(target, myPid);
			if (resolution.status !== "found") {
				notifyCommand(ctx, formatResolutionError(target, resolution, getActiveSessions(myPid)), "error", "Use an exact name or PID from /bridge-list.");
				return;
			}
			const session = resolution.session as RegistryEntry;

			const msg: BridgeMessage = {
				type: "ping",
				fromPid: myPid,
				fromName: myName,
				fromCwd: ctx.cwd,
				content: "",
				timestamp: Date.now(),
			};

			try {
				const receipt = await sendToSocket(session.socketPath, msg);
				const safe = safeSession(session);
				notifyCommand(ctx, receipt.acked ? `📡 Pong from "${safe.name}"${visibilityNotice(session)} received` : `📡 Ping delivered to "${safe.name}"${visibilityNotice(session)}, but ${receipt.warning}`, receipt.acked ? "success" : "warning", "Pong confirms the recipient process is reachable now.");
			} catch (err) {
				notifyCommand(ctx, `Ping to "${safeSession(session).name}" failed: ${err}`, "error", "Run /bridge-list to verify the target is still registered.");
			}
		},
	});

	// ── LLM Tools ─────────────────────────────────────────────────────────

	pi.registerTool({
		name: "set_session_visibility",
		label: "Set Pi Session Visibility",
		description:
			"Show or set this Pi agent session's pi-yo bridge visibility. " +
			"Use this when the user asks this Pi agent to go invisible, hide from bridge discovery, become visible again, or report visibility.",
		promptSnippet: "Hide or reveal this Pi session in pi-yo discovery",
		promptGuidelines: [
			"Only change the current Pi session's visibility; do not hide or reveal other sessions.",
			"Use invisible mode to remove this session from list_sessions, /bridge-list, pimsg list, and normal name/cwd/fuzzy targeting.",
			"Exact PID targeting still reaches an invisible session, so include the PID in your response when hiding.",
		],
		parameters: Type.Object({
			visibility: Type.String({
				description: "Use 'invisible', 'visible', or 'status'.",
			}),
		}),
		async execute(_toolCallId, params) {
			const requested = String(params.visibility ?? "status").toLowerCase();
			if (requested === "status") {
				const visibility = getSessionVisibility(currentRegistryEntry());
				return {
					content: [{ type: "text", text: visibilityStatusLine(visibility, myPid) }],
					details: { visibility, pid: myPid },
				};
			}
			if (requested !== "visible" && requested !== "invisible") {
				return {
					content: [{ type: "text", text: "visibility must be 'visible', 'invisible', or 'status'." }],
					isError: true,
				};
			}
			const result = setMyVisibility(requested as "visible" | "invisible");
			return {
				content: [{ type: "text", text: visibilityStatusLine(requested as "visible" | "invisible", myPid) }],
				details: { visibility: requested, pid: myPid, updated: result.updated },
				isError: !result.updated,
			};
		},
	});

	pi.registerTool({
		name: "list_sessions",
		label: "List Pi Sessions",
		description:
			"List all other Pi agent sessions currently running in other terminal windows. " +
			"Returns session names, PIDs, and working directories so you can communicate with them.",
		promptSnippet: "Discover other Pi sessions for cross-session messaging",
		parameters: Type.Object({}),
		async execute() {
			const sessions = getActiveSessions(myPid);

			if (sessions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No other Pi sessions are currently running. Ask the user to start another pi session in a separate terminal.",
						},
					],
					details: { sessions: [] },
				};
			}

			const list = sessions
				.map((rawSession) => {
					const s = safeSession(rawSession);
					const age = Math.round((Date.now() - rawSession.startedAt) / 60000);
					return `- name: "${s.name}"\n  pid: ${rawSession.pid}\n  cwd: ${s.cwd}\n  running: ${age} minutes`;
				})
				.join("\n\n");
			const duplicates = duplicateCwdWarnings(sessions);
			const duplicateBlock = duplicates.length > 0
				? `\n\nDuplicate cwd warning — target canonical PID/name explicitly:\n${duplicates.map((d) => `- ${d}`).join("\n")}`
				: "";

			return {
				content: [{ type: "text", text: `Other active Pi sessions:\n\n${list}${duplicateBlock}` }],
				details: { sessions, duplicateWarnings: duplicates },
			};
		},
	});

	pi.registerTool({
		name: "send_to_session",
		label: "Send to Pi Session",
		description:
			"Send a message to another Pi session running in a different terminal window. " +
			"The message will appear in that session's conversation and the AI there can read and respond to it. " +
			"Use list_sessions first to discover available sessions. " +
			"You can identify the target session by its name, PID, or working directory basename.",
		promptSnippet: "Send messages to other running Pi sessions",
		promptGuidelines: [
			"Use send_to_session when the user asks you to communicate with or send information to another Pi session.",
			"Use list_sessions before send_to_session if you don't know the target session's name or ID.",
		],
		parameters: Type.Object({
			target: Type.String({
				description:
					"The target session to send to. Can be a session name, PID (as string), or working directory basename.",
			}),
			message: Type.String({
				description: "The message content to send. Be clear and descriptive since the receiving AI will see this.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolution = resolveSession(params.target, myPid);

			if (resolution.status !== "found") {
				return {
					content: [{ type: "text", text: formatResolutionError(params.target, resolution, getActiveSessions(myPid)) }],
					isError: true,
					details: { target: safeText(params.target, 200), resolution },
				};
			}
			const session = resolution.session as RegistryEntry;

			const senderName = getMyName(ctx);
			const msg: BridgeMessage = {
				type: "message",
				fromPid: myPid,
				fromName: senderName,
				fromCwd: ctx.cwd,
				content: params.message,
				timestamp: Date.now(),
				isReply: false,
			};

			try {
				const receipt = await sendToSocket(session.socketPath, msg);
				const focus = maybeFocusSession(session);
				const safe = safeSession(session);
				return {
					content: [
						{
							type: "text",
							text: `Message delivered to "${safe.name}"${visibilityNotice(session)} (${safe.cwd}).${focusNotice(focus)}${receiptSuffix(receipt)}`,
						},
					],
					details: { to: safe.name, toCwd: safe.cwd, acked: receipt.acked, receipt: receipt.response, focus },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to deliver message to "${safeSession(session).name}": ${err}\n\nThe session may have exited. Try /bridge-list to see current sessions.`,
						},
					],
					isError: true,
					details: { target: safeText(params.target, 200), error: String(err) },
				};
			}
		},
	});

	// ── Reply tool ────────────────────────────────────────────────────────────
	// Sends with isReply:true so the receiver knows not to reply again (no loops).

	pi.registerTool({
		name: "reply_to_session",
		label: "Reply to Pi Session",
		description:
			"Send a reply back to a Pi or Claude Code session that sent you a message. " +
			"Use this instead of send_to_session when replying — it marks the message as a reply " +
			"so the receiver knows the exchange is complete and won't reply again, preventing loops.",
		promptSnippet: "Reply to incoming inter-session messages",
		promptGuidelines: [
			"When you receive an inter-session message (not marked as a reply), use reply_to_session to send a reply back to the sender after you have processed it.",
			"Always use reply_to_session (not send_to_session) for replies — it prevents infinite reply loops.",
		],
		parameters: Type.Object({
			target: Type.String({
				description: "The session to reply to. Use the sender's name or PID from the incoming message.",
			}),
			message: Type.String({
				description: "Your reply message.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolution = resolveSession(params.target, myPid);

			if (resolution.status !== "found") {
				return {
					content: [{ type: "text", text: formatResolutionError(params.target, resolution, getActiveSessions(myPid)) }],
					isError: true,
					details: { target: safeText(params.target, 200), resolution },
				};
			}
			const session = resolution.session as RegistryEntry;

			const msg: BridgeMessage = {
				type: "message",
				fromPid: myPid,
				fromName: getMyName(ctx),
				fromCwd: ctx.cwd,
				content: params.message,
				timestamp: Date.now(),
				isReply: true,
			};

			try {
				const receipt = await sendToSocket(session.socketPath, msg);
				const focus = maybeFocusSession(session);
				const safe = safeSession(session);
				return {
					content: [
						{
							type: "text",
							text: `Reply delivered to "${safe.name}"${visibilityNotice(session)} (${safe.cwd}).${focusNotice(focus)}${receiptSuffix(receipt)}`,
						},
					],
					details: { to: safe.name, toCwd: safe.cwd, acked: receipt.acked, receipt: receipt.response, focus },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to deliver reply to "${safeSession(session).name}": ${err}` }],
					isError: true,
				};
			}
		},
	});
}
