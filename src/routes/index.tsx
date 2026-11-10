import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { planSync, type SyncItem } from "@/lib/sync-plan";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Compu-Cart — Console de cartouches" },
      { name: "description", content: "Détection de cartouche, vérification d'intégrité, synchronisation des sauvegardes et lancement de jeu." },
      { property: "og:title", content: "Compu-Cart — Console de cartouches" },
      { property: "og:description", content: "Branchez, vérifiez, synchronisez, jouez." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type State = "empty" | "verifying" | "corrupt" | "syncing" | "intro" | "ready" | "running" | "error" | "ejecting" | "ejected";
type Manifest = { id: string; title: string; executable: string };
type Cart = { state: State; root?: string; manifest?: Manifest; intro?: { image: string | null; audio: string | null } };
type Log = { level: "info" | "ok" | "warn" | "error"; msg: string; at: number };
type Integrity = { ok: boolean; results: { file: string; ok: boolean }[] };
type Bridge = {
  on: (ch: string, cb: (d: any) => void) => void;
  launch: (root: string) => Promise<void>;
  eject?: () => Promise<void>;
  hide?: () => Promise<void>;
  quit?: () => Promise<void>;
};
const EJECTABLE: State[] = ["ready", "corrupt", "error"];

const STEPS: { key: State[]; label: string }[] = [
  { key: ["verifying"], label: "Intégrité" },
  { key: ["syncing"], label: "Sync" },
  { key: ["intro"], label: "Intro" },
  { key: ["running", "ready"], label: "Jeu" },
];

function jingle() {
  const ctx = new AudioContext();
  [523, 659, 784, 1047].forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "square"; o.frequency.value = f;
    g.gain.setValueAtTime(0.08, ctx.currentTime + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.3);
    o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.12); o.stop(ctx.currentTime + i * 0.12 + 0.3);
  });
}

export function Index() {
  const [cart, setCart] = useState<Cart>({ state: "empty" });
  const [logs, setLogs] = useState<Log[]>([]);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [sync, setSync] = useState<{ localDir: string; cartDir: string; plan: SyncItem[] } | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const timers = useRef<number[]>([]);
  const log = (level: Log["level"], msg: string) => setLogs((l) => [{ level, msg, at: Date.now() }, ...l].slice(0, 60));

  useEffect(() => {
    const b = (window as any).compucart as Bridge | undefined;
    if (!b) { log("warn", "Mode démo : aucun pont matériel (lancez l'app Windows)"); return; }
    setBridge(b);
    b.on("log", (d) => setLogs((l) => [d, ...l].slice(0, 60)));
    b.on("cart", setCart);
    b.on("integrity", setIntegrity);
    b.on("sync", setSync);
    log("ok", "Pont matériel connecté — en attente d'un branchement (détection par événements Windows)");
  }, []);

  // Intro sequence then launch.
  useEffect(() => {
    if (cart.state !== "intro") return;
    if (cart.intro?.audio) new Audio(cart.intro.audio).play().catch(jingle); else jingle();
    const t = window.setTimeout(() => {
      if (bridge && cart.root) bridge.launch(cart.root);
      else {
        setCart((c) => ({ ...c, state: "running" }));
        log("info", `Lancement simulé de ${cart.manifest?.title}`);
        timers.current.push(window.setTimeout(() => {
          log("info", "Jeu terminé (simulation) — synchronisation retour");
          setCart((c) => ({ ...c, state: "ready" }));
        }, 3500));
      }
    }, 3200);
    return () => clearTimeout(t);
  }, [cart.state]);

  const simulate = (corrupt = false) => {
    timers.current.forEach(clearTimeout);
    const manifest = { id: "star-runner", title: "STAR RUNNER", executable: "bin/StarRunner.exe" };
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    setIntegrity(null); setSync(null);
    log("info", "Cartouche détectée sur E:\\");
    setCart({ state: "verifying", root: "E:\\", manifest });
    at(1200, () => {
      const results = ["bin/StarRunner.exe", "data/assets.pak", "data/levels.pak"].map((file, i) => ({ file, ok: !(corrupt && i === 1) }));
      setIntegrity({ ok: !corrupt, results });
      if (corrupt) { log("error", "Intégrité compromise — lancement bloqué"); setCart({ state: "corrupt", root: "E:\\", manifest }); return; }
      log("ok", "Intégrité vérifiée"); setCart({ state: "syncing", root: "E:\\", manifest });
      at(1200, () => {
        const now = Date.now();
        const plan = planSync({ "slot1.sav": now - 9e6, "settings.cfg": now }, { "slot1.sav": now, "slot2.sav": now - 5e5, "settings.cfg": now - 1000 });
        setSync({ localDir: "%APPDATA%\\CompuCart\\saves\\star-runner", cartDir: "E:\\saves", plan });
        log("ok", `Sauvegardes synchronisées (${plan.filter((p) => p.action !== "skip").length} fichier(s))`);
        setCart({ state: "intro", root: "E:\\", manifest });
      });
    });
  };
  const eject = () => {
    if (bridge?.eject) { bridge.eject(); return; }
    timers.current.forEach(clearTimeout);
    const root = cart.root;
    setCart({ state: "ejecting", root });
    log("info", `Éjection de ${root} : écriture des données en attente…`);
    timers.current.push(window.setTimeout(() => {
      setIntegrity(null); setSync(null);
      setCart({ state: "ejected", root });
      log("ok", "Cartouche éjectée : vous pouvez la retirer en toute sécurité");
      timers.current.push(window.setTimeout(() => setCart({ state: "empty" }), 6000));
    }, 1200));
  };
  const canEject = !!cart.root && EJECTABLE.includes(cart.state);

  const activeIdx = STEPS.findIndex((s) => s.key.includes(cart.state));
  const levelCls = { info: "text-muted-foreground", ok: "text-success", warn: "text-warn", error: "text-destructive" };

  return (
    <main className="min-h-screen p-6 md:p-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-primary glow md:text-3xl">COMPU-CART</h1>
          <p className="mt-2 text-sm text-muted-foreground">{bridge ? "Système actif" : "Mode démo"} · cartouches externes</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!bridge && (<>
            <button onClick={() => simulate()} className="rounded-sm bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90">Insérer cartouche</button>
            <button onClick={() => simulate(true)} className="rounded-sm border border-destructive px-4 py-2 text-sm text-destructive hover:bg-destructive/10">Cartouche corrompue</button>
          </>)}
          <button onClick={eject} disabled={!canEject} title={canEject ? "Écrit les données puis déconnecte la cartouche" : "Disponible quand aucun jeu ni synchronisation n'est en cours"} className="rounded-sm border border-primary px-4 py-2 text-sm text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:border-border disabled:text-muted-foreground disabled:hover:bg-transparent">⏏ Éjecter</button>
          {bridge?.hide && <button onClick={() => bridge.hide?.()} className="rounded-sm border px-4 py-2 text-sm hover:bg-secondary">Réduire</button>}
          {bridge?.quit && <button onClick={() => bridge.quit?.()} className="rounded-sm border px-4 py-2 text-sm text-muted-foreground hover:bg-secondary">Quitter</button>}
        </div>
      </header>

      {(cart.state === "ejecting" || cart.state === "ejected") && (
        <div role="status" className={`mb-6 rounded-sm border-2 p-4 text-sm ${cart.state === "ejected" ? "border-success text-success" : "border-primary text-primary"}`}>
          {cart.state === "ejecting"
            ? `Éjection de ${cart.root ?? "la cartouche"} : écriture des données, ne retirez rien…`
            : `Vous pouvez retirer la cartouche ${cart.root ?? ""} en toute sécurité.`}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="panel p-6 lg:col-span-2">
          <div className={`flex items-center gap-5 rounded-sm border-2 border-dashed p-6 ${cart.state === "empty" ? "animate-slot" : "border-primary"}`}>
            <div className="grid h-20 w-16 place-items-center rounded-sm bg-secondary font-display text-xs text-primary">{cart.state === "empty" ? "—" : "CC"}</div>
            <div>
              <p className="font-display text-sm">{cart.state === "ejected" ? "CARTOUCHE ÉJECTÉE" : cart.manifest?.title ?? "INSÉREZ UNE CARTOUCHE"}</p>
              <p className="mt-2 text-xs text-muted-foreground">{cart.root ? [cart.root, cart.manifest?.executable].filter(Boolean).join(" · ") : "En attente d'un branchement…"}</p>
            </div>
            <span className="ml-auto rounded-sm bg-secondary px-3 py-1 text-xs uppercase tracking-widest text-primary">{cart.state}</span>
          </div>

          <ol className="mt-6 grid grid-cols-4 gap-2">
            {STEPS.map((s, i) => (
              <li key={s.label} className={`rounded-sm border px-3 py-2 text-center text-xs ${i < activeIdx ? "border-success text-success" : i === activeIdx ? "border-primary text-primary" : "text-muted-foreground"} ${cart.state === "corrupt" && i === 0 ? "border-destructive text-destructive" : ""}`}>
                {i + 1}. {s.label}
              </li>
            ))}
          </ol>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div>
              <h2 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Intégrité SHA-256</h2>
              {integrity ? integrity.results.map((r) => (
                <div key={r.file} className="flex justify-between border-b py-1 text-xs"><span>{r.file}</span><span className={r.ok ? "text-success" : "text-destructive"}>{r.ok ? "OK" : "ÉCHEC"}</span></div>
              )) : <p className="text-xs text-muted-foreground">—</p>}
            </div>
            <div>
              <h2 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Synchronisation</h2>
              {sync ? (<>
                {sync.plan.map((p) => (
                  <div key={p.file} className="flex justify-between border-b py-1 text-xs"><span>{p.file}</span>
                    <span className={p.action === "skip" ? "text-muted-foreground" : "text-accent"}>{p.action === "pull" ? "cartouche → PC" : p.action === "push" ? "PC → cartouche" : "à jour"}</span></div>
                ))}
                <p className="mt-2 break-all text-[10px] text-muted-foreground">{sync.localDir} ⇄ {sync.cartDir}</p>
              </>) : <p className="text-xs text-muted-foreground">—</p>}
            </div>
          </div>
        </section>

        <section className="panel p-6">
          <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Journal d'événements</h2>
          <ul className="max-h-[480px] space-y-1 overflow-auto text-xs">
            {logs.map((l, i) => (
              <li key={i} className={levelCls[l.level]}><span className="text-muted-foreground">{new Date(l.at).toLocaleTimeString()}</span> {l.msg}</li>
            ))}
          </ul>
        </section>
      </div>

      {cart.state === "intro" && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background">
          {cart.intro?.image ? <img src={cart.intro.image} alt={cart.manifest?.title} className="max-h-[70vh] animate-splash" /> : (
            <div className="animate-splash text-center">
              <p className="font-display text-4xl text-primary glow md:text-6xl">COMPU-CART</p>
              <p className="mt-6 font-display text-sm text-foreground">{cart.manifest?.title}</p>
            </div>
          )}
        </div>
      )}

      {cart.state === "running" && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-background" aria-live="polite">
          <div className="text-center">
            <p className="font-display text-sm text-primary/60">{cart.manifest?.title ?? "JEU"} EN COURS</p>
            <p className="mt-4 text-xs text-muted-foreground">Compu-Cart reprendra à la fermeture du jeu.</p>
          </div>
        </div>
      )}
    </main>
  );
}
