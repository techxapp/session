/**
 * Equations for plot_graph: a small parser for y = f(x) (no eval). It accepts the way people and models
 * write maths: `y = x^2`, `f(x) = 2x + 1`, `sin(x)/x`, `2sin x`, `|x|`, `x**3`, `√x`, `π`.
 * The result is a plain function of x that returns NaN outside its domain.
 */

export class MathError extends Error {}

type Fn = (x: number) => number;

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sec: (v) => 1 / Math.cos(v),
  csc: (v) => 1 / Math.sin(v),
  cot: (v) => 1 / Math.tan(v),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
};

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

/** Longest names first, so "sinh" wins over "sin" and "log10" over "log". */
const NAMES = [...Object.keys(FUNCS), ...Object.keys(CONSTS), "x"].sort((a, b) => b.length - a.length);

type Tok = { t: "num"; v: number } | { t: "name"; v: string } | { t: "op"; v: string };

const SYMBOLS: Record<string, string> = { "×": "*", "·": "*", "÷": "/", "−": "-", "–": "-", π: "pi", "√": "sqrt", "²": "^2", "³": "^3" };

function tokenize(src: string): Tok[] {
  let s = src;
  for (const [k, v] of Object.entries(SYMBOLS)) s = s.split(k).join(v);
  s = s.replace(/\*\*/g, "^").toLowerCase();
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (!m) throw new MathError(`Bad number at "${s.slice(i, i + 6)}".`);
      out.push({ t: "num", v: Number(m[1]) });
      i += m[1].length;
    } else if (/[a-z]/.test(c)) {
      // Letters run together ("xsinx", "2pix"), so split them into known names.
      const name = NAMES.find((n) => s.startsWith(n, i));
      if (!name) throw new MathError(`Unknown name "${/^[a-z]+/.exec(s.slice(i))![0]}": use x and functions like sin, sqrt, ln.`);
      out.push({ t: "name", v: name });
      i += name.length;
    } else if ("+-*/^()|".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
    } else if (c === "[" || c === "{") {
      out.push({ t: "op", v: "(" });
      i++;
    } else if (c === "]" || c === "}") {
      out.push({ t: "op", v: ")" });
      i++;
    } else {
      throw new MathError(`Unexpected "${c}".`);
    }
  }
  return out;
}

class Parser {
  private i = 0;
  /** Open |...| bars: inside one, a "|" closes it instead of starting an implicit product. */
  private absDepth = 0;
  constructor(private toks: Tok[]) {}

  parse(): Fn {
    if (!this.toks.length) throw new MathError("The equation is empty.");
    const f = this.expr();
    if (this.i < this.toks.length) throw new MathError(`Unexpected "${this.toks[this.i].v}".`);
    return f;
  }

  private peek() {
    return this.toks[this.i];
  }
  private isOp(v: string) {
    const t = this.peek();
    return t?.t === "op" && t.v === v;
  }
  private expect(v: string) {
    if (!this.isOp(v)) throw new MathError(`Expected "${v}".`);
    this.i++;
  }

  private expr(): Fn {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.toks[this.i++].v;
      const a = left;
      const b = this.term();
      left = op === "+" ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
    }
    return left;
  }

  /** Products, including implicit ones: 2x, 3(x+1), x sin x, (x+1)(x-1). */
  private term(): Fn {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
        this.i++;
        const a = left;
        const b = this.unary();
        left = t.v === "*" ? (x) => a(x) * b(x) : (x) => a(x) / b(x);
      } else if (t && (t.t === "num" || t.t === "name" || (t.t === "op" && (t.v === "(" || (t.v === "|" && !this.absDepth))))) {
        const a = left;
        const b = this.power();
        left = (x) => a(x) * b(x);
      } else {
        return left;
      }
    }
  }

  /** -x^2 is -(x^2). */
  private unary(): Fn {
    if (this.isOp("-")) {
      this.i++;
      const a = this.unary();
      return (x) => -a(x);
    }
    if (this.isOp("+")) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  /** Right-associative: 2^3^2 = 2^9; the exponent may be negative (x^-1). */
  private power(): Fn {
    const base = this.primary();
    if (!this.isOp("^")) return base;
    this.i++;
    const exp = this.unary();
    return (x) => pow(base(x), exp(x));
  }

  private primary(): Fn {
    const t = this.peek();
    if (!t) throw new MathError("The equation ends too early.");
    this.i++;
    if (t.t === "num") return () => t.v;
    if (t.t === "name") {
      if (t.v === "x") return (x) => x;
      if (t.v in CONSTS) {
        const v = CONSTS[t.v];
        return () => v;
      }
      const fn = FUNCS[t.v];
      // sin(x), or without brackets: sin x, sin x^2 (= sin(x^2)), sin 2x (= sin(2)·x, as on a calculator).
      const arg = this.isOp("(") ? this.primary() : this.power();
      return (x) => fn(arg(x));
    }
    if (t.v === "(") {
      const inner = this.expr();
      this.expect(")");
      return inner;
    }
    if (t.v === "|") {
      this.absDepth++;
      const inner = this.expr();
      this.expect("|");
      this.absDepth--;
      return (x) => Math.abs(inner(x));
    }
    throw new MathError(`Unexpected "${t.v}".`);
  }
}

/** Real powers: a negative base with an odd-denominator exponent (x^(1/3)) stays real. */
function pow(a: number, b: number): number {
  const r = Math.pow(a, b);
  if (!Number.isNaN(r) || a >= 0) return r;
  for (const d of [3, 5, 7]) {
    const n = Math.round(b * d);
    if (Math.abs(b * d - n) < 1e-9) return (n % 2 === 0 ? 1 : -1) * Math.pow(-a, b);
  }
  return NaN;
}

export interface Equation {
  /** As shown on the board: "y = x^2". */
  label: string;
  f: Fn;
}

/** Parse "y = <expr>", "f(x) = <expr>", "<expr> = y" or a bare expression of x. Throws MathError. */
export function parseEquation(text: string): Equation {
  const src = text.trim().replace(/\s+/g, " ");
  const sides = src.split("=");
  if (sides.length > 2) throw new MathError("Use one '='.");
  let rhs = src;
  if (sides.length === 2) {
    const isY = (s: string) => /^\s*(y|[a-z]\s*\(\s*x\s*\))\s*$/i.test(s);
    if (isY(sides[0])) rhs = sides[1];
    else if (isY(sides[1])) rhs = sides[0];
    else throw new MathError("Only equations like y = f(x) can be plotted.");
  }
  rhs = rhs.trim();
  if (/(^|[^a-z])y([^a-z]|$)/i.test(rhs)) throw new MathError("Only equations like y = f(x) can be plotted.");
  const f = new Parser(tokenize(rhs)).parse();
  return {
    label: `y = ${rhs}`,
    f: (x) => {
      const v = f(x);
      return Number.isFinite(v) ? v : NaN;
    },
  };
}

/** null when the equation parses, else why not (for schema refinements). */
export function equationError(text: string): string | null {
  try {
    parseEquation(text);
    return null;
  } catch (err) {
    if (err instanceof MathError) return err.message;
    throw err;
  }
}
