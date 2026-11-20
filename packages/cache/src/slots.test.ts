import { describe, expect, it } from "bun:test";
import { createSlots, SlotsClosed } from "./slots";

const never = (): Promise<void> => new Promise<void>(() => {});

describe("a bounded slot queue", () => {
  it("refuses every waiter when its owner closes, and none of them runs", async () => {
    const slots = createSlots(2);
    const active = [slots.withSlot(never), slots.withSlot(never)];
    const ran: string[] = [];
    const waiting = [
      slots.withSlot(async () => {
        ran.push("one");
      }),
      slots.withSlot(async () => {
        ran.push("two");
      }),
    ];
    const outcomes = waiting.map(async (job) => {
      try {
        await job;
        return "ran";
      } catch (error) {
        return error instanceof SlotsClosed ? "refused" : "other";
      }
    });
    await Promise.resolve();
    slots.close();
    expect(await Promise.all(outcomes)).toEqual(["refused", "refused"]);
    expect(ran).toEqual([]);
    expect(active).toHaveLength(2);
  });

  it("runs at most its limit, handing a freed slot to the next waiter", async () => {
    const slots = createSlots(1);
    let active = 0;
    let peak = 0;
    const work = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    };
    await Promise.all([slots.withSlot(work), slots.withSlot(work), slots.withSlot(work)]);
    expect(peak).toBe(1);
  });
});
