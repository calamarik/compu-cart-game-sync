import { describe, it, expect } from "vitest";
import { planSync } from "@/lib/sync-plan";

describe("planSync", () => {
  it("pulls newer cartridge save", () => expect(planSync({ a: 1000 }, { a: 9000 })[0]!.action).toBe("pull"));
  it("pushes newer local save", () => expect(planSync({ a: 9000 }, { a: 1000 })[0]!.action).toBe("push"));
  it("skips within 2s tolerance", () => expect(planSync({ a: 1000 }, { a: 2500 })[0]!.action).toBe("skip"));
  it("copies missing files both ways", () => {
    const p = planSync({ l: 1 }, { c: 1 });
    expect(p.find((x) => x.file === "l")!.action).toBe("push");
    expect(p.find((x) => x.file === "c")!.action).toBe("pull");
  });
});
