declare global {
  const __dirname: string;
}
(globalThis as any).__dirname = "./"; // stub value

import initRDKitModule from "@rdkit/rdkit";
import rdkitWasm from "@rdkit/rdkit/Code/MinimalLib/dist/RDKit_minimal.wasm";

let RDKitReady = (async () => {
  // override Emscripten WASM load so no fs/fetch is used
  const RDKit = await initRDKitModule({
    instantiateWasm(imports: WebAssembly.Imports, done: (inst: WebAssembly.Instance, mod: WebAssembly.Module) => void) {
      const instance = new WebAssembly.Instance(rdkitWasm as unknown as WebAssembly.Module, imports);
      done(instance, rdkitWasm as unknown as WebAssembly.Module);
      // @ts-ignore
      return instance.exports;
    }
  } as any);
  return RDKit;
})();

type Bond = { i: number; j: number; order: number };
function parseV2000Molblock(mb: string): {
  coords: [number, number][], symbols: string[], charges: number[], bonds: Bond[]
} {
  const lines = mb.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length < 4) throw new Error("Molblock too short");

  // guard against V3000
  if ((lines[3] || "").toUpperCase().includes("V3000") || lines.some(l => l.startsWith("M  V30"))) {
    throw new Error("V3000 molblock not supported");
  }

  const counts = lines[3] ?? "";
  let na = Number.NaN, nb = Number.NaN;
  if (counts.length >= 6) {
    na = parseInt(counts.slice(0, 3), 10);
    nb = parseInt(counts.slice(3, 6), 10);
  }
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    const m = counts.match(/^\s*(\d{1,3})\s+(\d{1,3})\b/);
    if (!m) throw new Error("Invalid counts line");
    na = parseInt(m[1], 10);
    nb = parseInt(m[2], 10);
  }

  const coords: [number, number][] = [];
  const symbols: string[] = [];
  const base = 4;

  for (let k = base; k < base + na; k++) {
    const ln = lines[k] ?? "";
    const x = parseFloat(ln.slice(0, 10)) || 0;
    const y = parseFloat(ln.slice(10, 20)) || 0;
    const sym = (ln.slice(31, 34).trim() || "C");
    coords.push([x, y]);
    symbols.push(sym);
  }

  const bonds: Bond[] = [];
  const bbase = base + na;
  for (let k = bbase; k < bbase + nb; k++) {
    const ln = lines[k] ?? "";
    const i = (parseInt(ln.slice(0, 3), 10) || 1) - 1;
    const j = (parseInt(ln.slice(3, 6), 10) || 1) - 1;
    const order = parseInt(ln.slice(6, 9), 10) || 1;
    bonds.push({ i, j, order });
  }

  // charges
  const chargeMap = new Map<number, number>();
  for (let k = bbase + nb; k < lines.length; k++) {
    const ln = lines[k] ?? "";
    if (ln.startsWith("M  CHG")) {
      const n = parseInt(ln.slice(6, 9), 10) || 0;
      let pos = 9;
      for (let t = 0; t < n; t++) {
        const idx = (parseInt(ln.slice(pos, pos + 4), 10) || 0) - 1;
        const chg = parseInt(ln.slice(pos + 4, pos + 8), 10) || 0;
        chargeMap.set(idx, chg);
        pos += 8;
      }
    }
  }
  const charges = Array.from({ length: na }, (_, i) => chargeMap.get(i) ?? 0);
  return { coords, symbols, charges, bonds };
}

class CharSet {
  h_single = "─"; v_single = "│"; slash = "/"; backslash = "╲";
  h_double = "═"; v_double = "║"; h_triple = "≡";
  static ascii(): CharSet {
    const c = new CharSet();
    c.h_single = "-"; c.v_single = "|"; c.slash = "/"; c.backslash = "\\";
    c.h_double = "="; c.v_double = "|"; c.h_triple = "#";
    return c;
  }
}

type Pt = [number, number];

const LINE_CHARS_ASCII = "-|\\/=#+";
const LINE_CHARS_UNI   = "─│╱╲═║≡┼+";
function isLineChar(ch: string) {
  return LINE_CHARS_ASCII.includes(ch) || LINE_CHARS_UNI.includes(ch);
}
// Bonds: draw lines; if another line is present, render a junction. Never overwrite atoms.
function setLine(grid: string[][], r: number, c: number, ch: string, useUnicode: boolean) {
  if (r < 0 || r >= grid.length || c < 0 || c >= grid[0].length) return;
  const existing = grid[r][c];
  if (existing === " ") {
    grid[r][c] = ch;
  } else if (isLineChar(existing) && isLineChar(ch)) {
    grid[r][c] = useUnicode ? "┼" : "+";
  } // else atom/label present: do nothing (atoms win)
}
// Atoms: always overwrite whatever is in the cell.
function setAtom(grid: string[][], r: number, c: number, ch: string) {
  if (r < 0 || r >= grid.length || c < 0 || c >= grid[0].length) return;
  grid[r][c] = ch;
}

class AsciiMolDrawer {
  constructor(
    public target_bond_chars = 1.0,
    use_unicode = true,
    public pad = 2,
    public scale_bump = 1.12,
    public max_bumps = 8,
    public show_formal_charge = true,
    public cs = (use_unicode ? new CharSet() : CharSet.ascii()),
  ) {}

  drawMolblock(mb: string): string {
    const { coords, symbols, charges, bonds } = parseV2000Molblock(mb);
    const labels = symbols.map((s, i) => this._label(s, charges[i]));

    let s = this._initialScale(coords, bonds);
    let pts: Pt[] = [];
    for (let attempt = 0; attempt <= this.max_bumps; attempt++) {
      pts = this._placeAtomsEvenGrid(coords, s);
      if (!this._labelsOverlap(pts, labels)) break;
      s *= this.scale_bump;
    }

    const [[minx, miny], [maxx, maxy]] = this._extentsWithLabelsAndBonds(pts, labels, bonds);
    const width = maxx - minx + 1 + 2 * this.pad;
    const height = maxy - miny + 1 + 2 * this.pad;
    const ox = -minx + this.pad;
    const oy = -miny + this.pad;
    const grid: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
    const useUnicode = this.cs.h_single !== "-";

    // Draw bonds (lines)
    for (const b of bonds) {
      const [x1, y1] = pts[b.i];
      const [x2, y2] = pts[b.j];
      const mx = Math.trunc((x1 + x2) / 2);
      const my = Math.trunc((y1 + y2) / 2);
      const ch = this._bondChar([x1, y1], [x2, y2], b.order);
      setLine(grid, my + oy, mx + ox, ch, useUnicode);
    }

    // Draw atoms (labels) — atoms overwrite
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const lab = labels[i];
      const start = x - Math.trunc(lab.length / 2);
      for (let k = 0; k < lab.length; k++) setAtom(grid, y + oy, start + ox + k, lab[k]);
    }

    const lines = grid.map((row) => row.join("").replace(/\s+$/g, ""));
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    return lines.join("\n");
  }

  private _label(sym: string, q: number): string {
    let s = sym.toLowerCase() === "c" ? "C" : sym;
    if (this.show_formal_charge && q) s += (Math.abs(q) === 1 ? (q > 0 ? "+" : "-") : (q > 0 ? "+" : "-") + Math.abs(q));
    return s;
  }

  private _initialScale(pts: [number, number][], bonds: Bond[]): number {
    const bl = bonds.map(b => {
      const [x1, y1] = pts[b.i]; const [x2, y2] = pts[b.j];
      return Math.hypot(x1 - x2, y1 - y2);
    });
    const avg = bl.length ? bl.reduce((a,b)=>a+b,0)/bl.length : 1.5;
    return (2.0 * this.target_bond_chars) / Math.max(avg, 1e-6);
  }

  private _nearestEven(x: number): number { return Math.trunc(2 * Math.round(x / 2)); }

  private _placeAtomsEvenGrid(pts: [number, number][], s: number): Pt[] {
    return pts.map(([xf, yf]) => [this._nearestEven(xf * s), this._nearestEven(-yf * s)] as Pt);
  }

  private _labelsOverlap(pts: Pt[], labels: string[]): boolean {
    const rows = new Map<number, Array<[number, number]>>();
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const lab = labels[i];
      const start = x - Math.trunc(lab.length / 2);
      const end = start + lab.length - 1;
      const arr = rows.get(y) ?? [];
      for (const [s0, e0] of arr) {
        if (!(end < s0 + 1 || start > e0 - 1)) return true; // touching counts as overlap
      }
      arr.push([start, end]); rows.set(y, arr);
    }
    return false;
  }

  private _extentsWithLabelsAndBonds(pts: Pt[], labels: string[], bonds: Bond[]): [[number, number],[number, number]] {
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i], lab = labels[i];
      const x0 = x - Math.trunc(lab.length / 2), x1 = x0 + lab.length - 1;
      minx = Math.min(minx, x0); maxx = Math.max(maxx, x1);
      miny = Math.min(miny, y);  maxy = Math.max(maxy, y);
    }
    for (const b of bonds) {
      const [x1, y1] = pts[b.i]; const [x2, y2] = pts[b.j];
      const mx = Math.trunc((x1 + x2) / 2), my = Math.trunc((y1 + y2) / 2);
      minx = Math.min(minx, mx); maxx = Math.max(maxx, mx);
      miny = Math.min(miny, my); maxy = Math.max(maxy, my);
    }
    return [[minx, miny], [maxx, maxy]];
  }

  private _bondChar([x1, y1]: Pt, [x2, y2]: Pt, order: number): string {
    if (y1 === y2) { // horizontal
      return order === 2 ? this.cs.h_double : order === 3 ? this.cs.h_triple : this.cs.h_single;
    } else if (x1 === x2) { // vertical
      return order === 2 ? this.cs.v_double : this.cs.v_single;
    } else { // diagonal
      return ((x2 - x1) * (y2 - y1) < 0) ? this.cs.slash : this.cs.backslash;
    }
  }
}


export default {
 async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Choose a key: IP for public traffic (simple), or API key/user id if available.
    // Cloudflare docs recommend stable user/tenant identifiers over IPs.
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    const key = `public:${ip}`; // or: `key:${req.headers.get('authorization')}`

    // Check the limiter before doing RDKit work
    const { success, remaining, reset } = await env.PUBLIC_RL.limit({ key });
    if (!success) {
      // optional: tell the client when to retry
      const headers = new Headers({ "Retry-After": "60", "Content-Type": "text/plain; charset=utf-8" });
      return new Response("429 Too Many Requests – limit is 100/min", { status: 429, headers });
    }

    const nameParam = url.searchParams.get("name");
    const smiParam = url.searchParams.get("smi");
    const echoSmi = url.searchParams.get("echo") === "1";
    if (nameParam && smiParam) {
      return new Response("Both 'name' and 'smi' provided; supply only one.", {
        status: 422,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    let smi = smiParam || "";
    if (!smi && nameParam) {
      try {
        const r = await fetch(env.OPSIN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: String(nameParam) })
        });
        if (!r.ok) {
          return new Response(`Name-to-SMILES conversion failed (HTTP ${r.status})`, {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        }
        const data = await r.json() as { success?: boolean; smiles?: string };
        if (!data?.success || !data?.smiles) {
          return new Response("Name-to-SMILES conversion failed", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        }
        smi = String(data.smiles);
      } catch (e) {
        return new Response("Name-to-SMILES conversion error", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
    }

    const RDKit = await RDKitReady;       // already initialized at startup
    if (!smi) return new Response("Usage: /?smi=c1ccccc1 or /?name=acetamide", { status: 400 });

    const mol = RDKit.get_mol(String(smi));
    if (!mol) return new Response("Invalid SMILES", { status: 400 });
    try {
      if (!mol.has_coords()) mol.set_new_coords(true);
      const molblock = mol.get_molblock();
      const art = new AsciiMolDrawer(1.0, url.searchParams.get("ascii") !== "1").drawMolblock(molblock);
      let responseContent;
      if (echoSmi) {
        responseContent = `${smi}\n${art}\n`;
      } else {
        responseContent = `${art}\n`;
      }
      
      // Enable very long-lived client-side caching (1 year)
      const cacheHeaders = {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
        "expires": new Date(Date.now() + 31536000 * 1000).toUTCString()
      };
      
      return new Response(responseContent, { headers: cacheHeaders });
    } finally { mol.delete(); }
  }
}

interface Env {
  PUBLIC_RL: {
    limit(input: { key: string }): Promise<{ success: boolean; remaining?: number; reset?: number }>;
  };
  OPSIN_URL: string;
}
