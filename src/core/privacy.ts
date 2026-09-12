import type { Plan } from "../contracts/types.js";

export class PrivacyError extends Error {}
const marker = "REDACTED";

export function validateSecretBindings(bindings: Plan["secretBindings"]): void {
  if (bindings.length > 32) throw new PrivacyError("At most 32 secret bindings are supported");
  const names = new Set<string>();
  for (const binding of bindings) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(binding.name) || names.has(binding.name)) throw new PrivacyError("Invalid or repeated secret binding name");
    if (["PATH", "LANG", "TZ", "HOME", "PWD", "TMPDIR", "SHELL"].includes(binding.name) || /^(NODE_|LD_|DYLD_|NPM_CONFIG_|UV_|OPENSSL_|LC_)/.test(binding.name)) throw new PrivacyError("Runtime-control variables cannot be secret bindings");
    names.add(binding.name);
  }
}

/** Exact known-value masking, not general detection of sensitive information. */
export class SecretMask {
  private readonly values: string[];
  constructor(values: string[] = []) { this.values = [...new Set(values.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length); }
  get active(): boolean { return this.values.length > 0; }
  contains(text: string): boolean { return this.values.some(value => text.includes(value)); }
  text(text: string): string { return this.contains(text) ? marker : text; }
  assertPublic(value: unknown): void {
    if (this.json(value).redacted) throw new PrivacyError("A bound secret occurs in public configuration or identity; remove it before running");
  }
  assertPublicBytes(bytes: Buffer): void {
    const text = bytes.toString("utf8");
    if (this.contains(text) || this.values.some(value => text.includes(JSON.stringify(value).slice(1, -1)))) throw new PrivacyError("A bound secret occurs in pinned input bytes; remove it before running");
  }
  json<T>(value: T): { value: T; redacted: boolean } {
    if (!this.active) return { value, redacted: false };
    let redacted = false;
    const visit = (item: unknown): unknown => {
      if (typeof item === "string" || typeof item === "number") {
        if (this.contains(String(item))) { redacted = true; return typeof item === "string" ? marker : null; }
        return item;
      }
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
        if (this.contains(key)) throw new PrivacyError("A bound secret occurs in a structural field name; capture stopped");
        return [key, visit(entry)];
      }));
      return item;
    };
    return { value: visit(value) as T, redacted };
  }
  stream(): { write: (text: string) => { text: string; redacted: boolean }; end: () => { text: string; redacted: boolean } } {
    let pending = "";
    const longest = Math.max(1, ...this.values.map(value => value.length));
    const consume = (text: string, final: boolean) => {
      pending += text; let output = ""; let index = 0; let redacted = false;
      while (index < pending.length && (final || pending.length - index >= longest)) {
        const match = this.values.find(value => pending.startsWith(value, index));
        if (match) { output += marker; index += match.length; redacted = true; }
        else { const width = pending.codePointAt(index)! > 0xffff ? 2 : 1; output += pending.slice(index, index + width); index += width; }
      }
      pending = pending.slice(index); return { text: output, redacted };
    };
    return { write: text => consume(text, false), end: () => consume("", true) };
  }
}

export class SecretContext {
  readonly mask: SecretMask;
  private incomplete = false;
  private readonly recipients: Record<"agent" | "environment", Record<string, string>> = { agent: {}, environment: {} };
  constructor(bindings: Plan["secretBindings"], environment: NodeJS.ProcessEnv = process.env, required = true) {
    validateSecretBindings(bindings);
    const values: string[] = []; let bytes = 0;
    for (const binding of bindings) {
      const value = environment[binding.name];
      if (value === undefined) { this.incomplete = true; if (required) throw new PrivacyError("A declared secret binding is missing from the operator environment"); else continue; }
      const size = Buffer.byteLength(value);
      if (size < 8 || size > 4096 || value.includes("\0") || value.includes(marker) || marker.includes(value)) {
        throw new PrivacyError("Secret values must contain 8–4096 UTF-8 bytes, without NUL or the reserved masking marker");
      }
      if ((bytes += size) > 16384) throw new PrivacyError("Total secret binding size exceeds 16 KiB");
      values.push(value); this.recipients[binding.recipient][binding.name] = value;
    }
    this.mask = new SecretMask(values);
  }
  environment(role: "agent" | "environment"): Record<string, string> { return { ...this.recipients[role] }; }
  assertComplete(): void { if (this.incomplete) throw new PrivacyError("A declared secret is missing or invalid (8–4096 UTF-8 bytes; no NUL or reserved masking marker)"); }
}
