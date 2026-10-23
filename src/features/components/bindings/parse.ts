// Binding templates (architecture v3 section 4.5): Atrium's own tokenizer and parser. There is no
// eval and no Function anywhere in this folder; templates are parsed into a small tree that
// evaluate.ts walks. Isomorphic: no browser-only or Node-only APIs.

export const MAX_TEMPLATE_BYTES = 2048;

export type Pos = number;
export type Node =
  | { k: "num"; v: number; p: Pos }
  | { k: "str"; v: string; p: Pos }
  | { k: "lit"; v: boolean | null; p: Pos }
  | { k: "id"; name: string; p: Pos }
  | { k: "get"; obj: Node; key: string; p: Pos }
  | { k: "idx"; obj: Node; key: Node; p: Pos }
  | { k: "call"; obj: Node; method: string; args: Node[]; p: Pos }
  | { k: "un"; op: "!" | "-"; e: Node; p: Pos }
  | { k: "bin"; op: string; a: Node; b: Node; p: Pos }
  | { k: "tern"; c: Node; a: Node; b: Node; p: Pos }
  | { k: "pipe"; e: Node; name: string; args: Node[]; p: Pos };

export type Part = { text: string } | { expr: Node; start: number; end: number };
export type ParsedTemplate = { parts: Part[]; whole: boolean };

export class BindingError extends Error {
  constructor(
    message: string,
    public code: string,
    public position?: number,
  ) {
    super(message);
  }
}

type Tok = { t: "num" | "str" | "id" | "op" | "eof"; v: string; p: number };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", ".", "[", "]", "(", ")", ",", "|"];
/** Path segments that would reach an object's prototype; refused wherever they appear. */
export const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function tokenize(src: string, offset: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const p = offset + i;
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0], p });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1]!;
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new BindingError(`A text in quotes is not closed.`, "binding.syntax", p);
      out.push({ t: "str", v: s, p });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0], p });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new BindingError(`"${ch}" is not allowed in a binding.`, "binding.syntax", p);
    out.push({ t: "op", v: op, p });
    i += op.length;
  }
  out.push({ t: "eof", v: "", p: offset + src.length });
  return out;
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok {
    return this.toks[this.i]!;
  }
  private next(): Tok {
    return this.toks[this.i++]!;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.t === "op" && t.v === v;
  }
  private expect(v: string): Tok {
    const t = this.next();
    if (t.t !== "op" || t.v !== v) throw unexpected(t, `"${v}"`);
    return t;
  }
  parseAll(): Node {
    const e = this.pipe();
    const t = this.peek();
    if (t.t !== "eof") throw unexpected(t);
    return e;
  }
  pipe(): Node {
    let e = this.ternary();
    while (this.isOp("|")) {
      const bar = this.next();
      const name = this.next();
      if (name.t !== "id") throw new BindingError(`A filter name is missing after "|".`, "binding.syntax", bar.p);
      const args: Node[] = [];
      if (this.isOp("(")) {
        this.next();
        if (!this.isOp(")")) {
          do args.push(this.ternary());
          while (this.isOp(",") && this.next());
        }
        this.expect(")");
      }
      e = { k: "pipe", e, name: name.v, args, p: name.p };
    }
    return e;
  }
  ternary(): Node {
    const c = this.or();
    if (this.isOp("?")) {
      const q = this.next();
      const a = this.ternary();
      this.expect(":");
      const b = this.ternary();
      return { k: "tern", c, a, b, p: q.p };
    }
    return c;
  }
  private binLevel(ops: string[], sub: () => Node): Node {
    let a = sub();
    for (;;) {
      const t = this.peek();
      if (t.t === "op" && ops.includes(t.v)) {
        this.next();
        a = { k: "bin", op: t.v, a, b: sub(), p: t.p };
      } else return a;
    }
  }
  or = (): Node => this.binLevel(["||"], this.and);
  and = (): Node => this.binLevel(["&&"], this.eq);
  eq = (): Node => this.binLevel(["==", "!="], this.rel);
  rel = (): Node => this.binLevel(["<", "<=", ">", ">="], this.add);
  add = (): Node => this.binLevel(["+", "-"], this.mul);
  mul = (): Node => this.binLevel(["*", "/", "%"], this.unary);
  unary = (): Node => {
    if (this.isOp("!") || this.isOp("-")) {
      const t = this.next();
      return { k: "un", op: t.v as "!" | "-", e: this.unary(), p: t.p };
    }
    return this.postfix();
  };
  private postfix(): Node {
    let e = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        const dot = this.next();
        const name = this.next();
        if (name.t !== "id") throw new BindingError(`A name is missing after ".".`, "binding.syntax", dot.p);
        if (FORBIDDEN_SEGMENTS.has(name.v)) throw forbidden(name.v, name.p);
        if (this.isOp("(")) {
          this.next();
          const args: Node[] = [];
          if (!this.isOp(")")) {
            do args.push(this.ternary());
            while (this.isOp(",") && this.next());
          }
          this.expect(")");
          e = { k: "call", obj: e, method: name.v, args, p: name.p };
        } else e = { k: "get", obj: e, key: name.v, p: name.p };
      } else if (this.isOp("[")) {
        const b = this.next();
        const key = this.pipe();
        this.expect("]");
        if (key.k === "str" && FORBIDDEN_SEGMENTS.has(key.v)) throw forbidden(key.v, key.p);
        e = { k: "idx", obj: e, key, p: b.p };
      } else if (this.isOp("(")) {
        throw new BindingError(`Only find(...) can be called in a binding.`, "binding.call", this.peek().p);
      } else return e;
    }
  }
  private primary(): Node {
    const t = this.next();
    if (t.t === "num") return { k: "num", v: Number(t.v), p: t.p };
    if (t.t === "str") return { k: "str", v: t.v, p: t.p };
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false") return { k: "lit", v: t.v === "true", p: t.p };
      if (t.v === "null") return { k: "lit", v: null, p: t.p };
      if (FORBIDDEN_SEGMENTS.has(t.v)) throw forbidden(t.v, t.p);
      return { k: "id", name: t.v, p: t.p };
    }
    if (t.t === "op" && t.v === "(") {
      const e = this.pipe();
      this.expect(")");
      return e;
    }
    throw unexpected(t);
  }
}

function forbidden(name: string, p: number): BindingError {
  return new BindingError(`"${name}" cannot be used in a binding path.`, "binding.forbidden", p);
}

function unexpected(t: Tok, wanted?: string): BindingError {
  if (t.t === "eof") return new BindingError(`The expression ends too early${wanted ? `; expected ${wanted}` : ""}.`, "binding.syntax", t.p);
  return new BindingError(`Unexpected "${t.v}"${wanted ? `; expected ${wanted}` : ""}.`, "binding.syntax", t.p);
}

/** Parses one expression (the inside of `{{ }}`). `offset` is its position in the template. */
export function parseExpression(src: string, offset = 0): Node {
  if (!src.trim()) throw new BindingError(`An empty {{ }} has nothing to show.`, "binding.empty", offset);
  return new Parser(tokenize(src, offset)).parseAll();
}

const cache = new Map<string, ParsedTemplate>();

/** Splits a template into literal text and expressions. Throws BindingError. */
export function parseTemplate(template: string): ParsedTemplate {
  const hit = cache.get(template);
  if (hit) return hit;
  if (byteLength(template) > MAX_TEMPLATE_BYTES) {
    throw new BindingError(`This binding is longer than the 2 KB limit (${byteLength(template)} bytes).`, "binding.too_long");
  }
  const parts: Part[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{{", i);
    if (open === -1) {
      parts.push({ text: template.slice(i) });
      break;
    }
    if (open > i) parts.push({ text: template.slice(i, open) });
    const close = findClose(template, open + 2);
    if (close === -1) throw new BindingError(`A "{{" is never closed with "}}".`, "binding.syntax", open);
    const inner = template.slice(open + 2, close);
    parts.push({ expr: parseExpression(inner, open + 2), start: open, end: close + 2 });
    i = close + 2;
  }
  const exprs = parts.filter((p) => "expr" in p);
  const whole = exprs.length === 1 && parts.every((p) => "expr" in p || !p.text.trim());
  const out = { parts, whole };
  if (cache.size > 2000) cache.clear();
  cache.set(template, out);
  return out;
}

/** The index of the "}}" closing an expression that starts at `from` (quotes are skipped). */
function findClose(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) j += s[j] === "\\" ? 2 : 1;
      i = j;
    } else if (ch === "}" && s[i + 1] === "}") return i;
  }
  return -1;
}

/** Every root identifier a template reads (data source names and $roots). Empty when it does not parse. */
export function rootsOf(template: string): string[] {
  let parsed: ParsedTemplate;
  try {
    parsed = parseTemplate(template);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const walk = (n: Node): void => {
    switch (n.k) {
      case "id":
        out.add(n.name);
        return;
      case "get":
        return walk(n.obj);
      case "idx":
        walk(n.obj);
        return walk(n.key);
      case "call":
        walk(n.obj);
        return n.args.forEach(walk);
      case "un":
        return walk(n.e);
      case "bin":
        walk(n.a);
        return walk(n.b);
      case "tern":
        walk(n.c);
        walk(n.a);
        return walk(n.b);
      case "pipe":
        walk(n.e);
        return n.args.forEach(walk);
      default:
        return;
    }
  };
  for (const p of parsed.parts) if ("expr" in p) walk(p.expr);
  return [...out];
}

/** Root paths a template reads, as dotted strings ("cpu.value", "$param.cpu.value"); only static segments. */
export function pathsOf(template: string): string[] {
  let parsed: ParsedTemplate;
  try {
    parsed = parseTemplate(template);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const pathOf = (n: Node): string | null => {
    if (n.k === "id") return n.name;
    if (n.k === "get") {
      const b = pathOf(n.obj);
      return b === null ? null : `${b}.${n.key}`;
    }
    if (n.k === "idx" && (n.key.k === "num" || n.key.k === "str")) {
      const b = pathOf(n.obj);
      return b === null ? null : `${b}.${n.key.v}`;
    }
    return null;
  };
  const walk = (n: Node): void => {
    const p = pathOf(n);
    if (p !== null) {
      out.add(p);
      return;
    }
    switch (n.k) {
      case "get":
        return walk(n.obj);
      case "idx":
        walk(n.obj);
        return walk(n.key);
      case "call":
        walk(n.obj);
        return n.args.forEach(walk);
      case "un":
        return walk(n.e);
      case "bin":
        walk(n.a);
        return walk(n.b);
      case "tern":
        walk(n.c);
        walk(n.a);
        return walk(n.b);
      case "pipe":
        walk(n.e);
        return n.args.forEach(walk);
      default:
        return;
    }
  };
  for (const p of parsed.parts) if ("expr" in p) walk(p.expr);
  return [...out];
}

/** Root identifiers with their positions in the template, for rewriting (library parameters). */
export function rootSpans(template: string): { name: string; start: number; end: number; next?: string }[] {
  const parsed = parseTemplate(template);
  const out: { name: string; start: number; end: number; next?: string }[] = [];
  const walk = (n: Node, parentGet?: string): void => {
    switch (n.k) {
      case "id":
        out.push({ name: n.name, start: n.p, end: n.p + n.name.length, ...(parentGet ? { next: parentGet } : {}) });
        return;
      case "get":
        return walk(n.obj, n.key);
      case "idx":
        walk(n.obj);
        return walk(n.key);
      case "call":
        walk(n.obj);
        return n.args.forEach((a) => walk(a));
      case "un":
        return walk(n.e);
      case "bin":
        walk(n.a);
        return walk(n.b);
      case "tern":
        walk(n.c);
        walk(n.a);
        return walk(n.b);
      case "pipe":
        walk(n.e);
        return n.args.forEach((a) => walk(a));
      default:
        return;
    }
  };
  for (const p of parsed.parts) if ("expr" in p) walk(p.expr);
  return out;
}

/** Replaces root identifiers (or `$param.<name>` pairs) in a template; `fn` returns the new text or null to keep. */
export function rewriteRoots(template: string, fn: (name: string, next?: string) => { text: string; consumeNext?: boolean } | null): string {
  const spans = rootSpans(template).sort((a, b) => b.start - a.start);
  let out = template;
  for (const s of spans) {
    const r = fn(s.name, s.next);
    if (!r) continue;
    let end = s.end;
    if (r.consumeNext && s.next) {
      const m = new RegExp(`^\\s*\\.\\s*${s.next.replace(/\$/g, "\\$")}`).exec(out.slice(end));
      if (m) end += m[0].length;
    }
    out = out.slice(0, s.start) + r.text + out.slice(end);
  }
  return out;
}
