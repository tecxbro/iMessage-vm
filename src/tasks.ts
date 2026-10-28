/**
 * Task path: instruction text -> mutate per-binding SiteSpec -> write the page
 * onto the Maritime computer's disk -> open/reload it in Chromium on the desktop.
 * Stands in for the real agent harness; the iMessage route and /task API both
 * feed through here so "text a task, watch the computer work" is provable now.
 *
 * Note: computer `exec` has no X display — GUI navigation goes through the
 * actions API (click omnibox -> type file:// URL -> Return), which is also how
 * the real harness's `computer` tool would do it.
 */
import { writeFile, execOnComputer, desktopAction, type MaritimeComputer } from "./maritime.js";
import { dirname } from "node:path";
import { applyInstruction, renderSite, newSite, type SiteSpec } from "./site.js";

export type TaskState = "idle" | "working" | "complete" | "error";

export type ItemStatus = "pending" | "active" | "done" | "error" | "cancelled";
export interface TaskItem {
  id: string;
  text: string;
  status: ItemStatus;
}

interface TaskRuntime {
  spec: SiteSpec;
  state: TaskState;
  siteOpened: boolean;
  lastNote: string;
  running: Promise<string> | null;
  items: TaskItem[];
}

const MAX_ITEMS = 20;

const SITE_PATH = "/home/desk/site/index.html";
const SITE_URL = `file://${SITE_PATH}`;
// omnibox position in the last screenshot frame (1280x800 screen -> 1200x750 shot)
const OMNIBOX: [number, number] = [500, 81];

export interface PersistedSite {
  spec: SiteSpec;
  siteOpened: boolean;
}

export class TaskRunner {
  private rt = new Map<string, TaskRuntime>();

  constructor(private opts: {
    seed?: Record<string, PersistedSite>;
    onChange?: (ref: string, s: PersistedSite) => void;
  } = {}) {}

  stateFor(ref: string): { state: TaskState; note: string; items: TaskItem[] } {
    const r = this.rt.get(ref) ?? this.hydrate(ref);
    return { state: r?.state ?? "idle", note: r?.lastNote ?? "", items: r?.items ?? [] };
  }

  /** Drop every queued instruction for the ref; the in-flight one finishes. */
  cancelPending(ref: string): number {
    const r = this.rt.get(ref);
    if (!r) return 0;
    let n = 0;
    for (const it of r.items) {
      if (it.status === "pending") {
        it.status = "cancelled";
        n++;
      }
    }
    return n;
  }

  private hydrate(ref: string): TaskRuntime | undefined {
    const s = this.opts.seed?.[ref];
    if (!s) return undefined;
    const r: TaskRuntime = { spec: s.spec, state: "idle", siteOpened: s.siteOpened, lastNote: "", running: null, items: [] };
    this.rt.set(ref, r);
    return r;
  }

  private persist(ref: string, r: TaskRuntime) {
    this.opts.onChange?.(ref, { spec: r.spec, siteOpened: r.siteOpened });
  }

  /** Serialized per binding — only one desktop writer at a time. */
  run(ref: string, computer: () => Promise<MaritimeComputer>, text: string): Promise<string> {
    const r = this.rt.get(ref) ?? this.hydrate(ref) ?? { spec: newSite("Untitled"), state: "idle" as TaskState, siteOpened: false, lastNote: "", running: null, items: [] };
    this.rt.set(ref, r);
    const item: TaskItem = { id: `i${Date.now().toString(36)}${r.items.length}`, text, status: "pending" };
    r.items.push(item);
    if (r.items.length > MAX_ITEMS) r.items.splice(0, r.items.length - MAX_ITEMS);
    const job = (r.running ?? Promise.resolve("")).then(() => this.exec(ref, r, computer, item));
    r.running = job.catch(() => "");
    return job;
  }

  private async exec(ref: string, r: TaskRuntime, getComputer: () => Promise<MaritimeComputer>, item: TaskItem): Promise<string> {
    if (item.status === "cancelled") return "skipped";
    item.status = "active";
    r.state = "working";
    try {
      const c = await getComputer();
      const note = applyInstruction(r.spec, item.text);
      r.spec.updatedAt = new Date().toISOString();
      // files PUT 404s on a missing parent dir — create it first
      await execOnComputer(c.id, `mkdir -p ${dirname(SITE_PATH)}`, 10);
      await writeFile(c.id, SITE_PATH, renderSite(r.spec));

      if (!r.siteOpened) {
        await desktopAction(c.id, { action: "left_click", coordinate: OMNIBOX, no_screenshot: true });
        await desktopAction(c.id, { action: "key", text: "ctrl+a", no_screenshot: true });
        await desktopAction(c.id, { action: "type", text: SITE_URL, no_screenshot: true });
        await desktopAction(c.id, { action: "key", text: "Return" });
        r.siteOpened = true;
      } else {
        await desktopAction(c.id, { action: "key", text: "F5" });
      }
      r.state = "complete";
      r.lastNote = note;
      item.status = "done";
      this.persist(ref, r);
      return note;
    } catch (e) {
      r.state = "error";
      r.lastNote = String(e).slice(0, 160);
      item.status = "error";
      throw e;
    }
  }
}
