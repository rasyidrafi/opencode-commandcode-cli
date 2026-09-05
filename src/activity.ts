function compact(value: string, max = 240): string {
  const text = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function argumentSummary(input: unknown): string {
  if (input === undefined || input === null) return "";
  return JSON.stringify(input, (key, value) =>
    /^(content|contents|body|patch|diff|old_string|new_string|prompt|token|password|authorization|api_?key)$/i.test(key)
      ? "[omitted]" : value) ?? "";
}

/** Match queued inputs to running calls; queueing alone does not mean execution. */
export class ActivityTranslator {
  private inputs = new Map<string, unknown>();
  private running = new Set<string>();

  event(frame: Record<string, unknown>): string | undefined {
    const id = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
    if (frame.type === "tool_queued") {
      if (id && !this.running.has(id)) this.inputs.set(id, frame.input);
      return;
    }
    if (frame.type !== "tool_running") return;
    const name = typeof frame.toolName === "string" && frame.toolName ? frame.toolName : "tool";
    const key = id || `name:${name}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    const input = id ? this.inputs.get(id) : undefined;
    this.inputs.delete(id);
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const path = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
    let title: string;
    if (name === "read_file" && (path || Array.isArray(args.paths))) {
      title = `Read ${path || (args.paths as unknown[]).filter(p => typeof p === "string").join(", ")}`;
      if (typeof args.offset === "number") title += `, offset ${args.offset}`;
      if (typeof args.limit === "number") title += `, limit ${args.limit}`;
    } else if (name === "read_directory" && path) title = `List ${path}`;
    else if ((name === "edit_file" || name === "write_file") && path) title = `Edit ${path}`;
    else if (["shell", "shell_command", "run_command", "powershell"].includes(name) && typeof args.command === "string") title = `Shell ${args.command}`;
    else if (name === "web_search" && typeof args.query === "string") title = `Web search: ${args.query}`;
    else if (name === "agent" && typeof args.description === "string") title = `Agent ${args.description}`;
    else {
      const summary = argumentSummary(input);
      const description = typeof frame.description === "string" ? frame.description : "";
      title = summary ? `${name}: ${summary}` : description ? `${name}: ${description}` : `Running ${name}`;
    }
    return `[Command Code tool: ${compact(title)}]\n`;
  }
}
