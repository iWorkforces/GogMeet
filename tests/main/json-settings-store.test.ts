import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockSettings } from "../helpers/test-utils.js";

const { appState } = vi.hoisted(() => ({
  appState: { userData: "" },
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? appState.userData : "/tmp"),
  },
}));

describe("JsonSettingsStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gogmeet-jss-"));
    appState.userData = dir;
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads defaults when missing, save and update round-trip", async () => {
    const { createJsonSettingsStore } =
      await import("../../src/main/infrastructure/settings/json-settings-store.js");
    const store = createJsonSettingsStore();
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    const updated = await store.update({ openBeforeMinutes: 4, quietHoursEnabled: true });
    expect(updated.openBeforeMinutes).toBe(4);
    expect(store.get().openBeforeMinutes).toBe(4);
    await store.save(createMockSettings({ openBeforeMinutes: 6, showTomorrowMeetings: false }));
    const again = await store.load();
    expect(again.ok && again.value.openBeforeMinutes).toBe(6);
    expect(again.ok && again.value.showTomorrowMeetings).toBe(false);
  });

  it("handles corrupt file without throwing", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "settings.json"), "not-json", "utf-8");
    const { createJsonSettingsStore } =
      await import("../../src/main/infrastructure/settings/json-settings-store.js");
    const store = createJsonSettingsStore();
    const loaded = await store.load();
    expect(loaded).toHaveProperty("ok");
  });

  it("keeps the committed cache when a disk write fails and recovers on the next update", async () => {
    // Given a committed snapshot and a directory obstructing settings.json.
    const { createJsonSettingsStore } =
      await import("../../src/main/infrastructure/settings/json-settings-store.js");
    const store = createJsonSettingsStore();
    await store.load();
    const committed = await store.update({ openBeforeMinutes: 4 });
    const path = join(dir, "settings.json");
    await rm(path);
    await mkdir(path);

    // When persistence cannot write the proposed change.
    await expect(store.update({ openBeforeMinutes: 7 })).rejects.toThrow();

    // Then the prior cache survives, and a later save can commit normally.
    expect(store.get()).toEqual(committed);
    await rm(path, { recursive: true });
    const recovered = await store.update({ showCompletedTodayMeetings: true });
    expect(recovered).toEqual({ ...committed, showCompletedTodayMeetings: true });
    const reloaded = await createJsonSettingsStore().load();
    expect(reloaded).toEqual({ ok: true, value: recovered });
  });

  it("clamps openBeforeMinutes and migrates schema v1", async () => {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        openBeforeMinutes: 99,
        launchAtLogin: true,
        showTomorrowMeetings: true,
        windowAlert: false,
      }),
      "utf-8",
    );
    const { createJsonSettingsStore } =
      await import("../../src/main/infrastructure/settings/json-settings-store.js");
    const store = createJsonSettingsStore();
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.openBeforeMinutes).toBeLessThanOrEqual(10);
      expect(loaded.value.schemaVersion).toBe(3);
      expect(loaded.value.showCompletedTodayMeetings).toBe(false);
    }
  });

  it("migrates v2 settings to v3 with showCompletedTodayMeetings default false", async () => {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        openBeforeMinutes: 2,
        launchAtLogin: false,
        showTomorrowMeetings: true,
        windowAlert: true,
        autoOpenEnabled: true,
        alertLeadSeconds: 60,
        nativeNotifications: true,
        lateJoinGraceMinutes: 0,
        quietHoursEnabled: false,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
      }),
      "utf-8",
    );
    const { createJsonSettingsStore } =
      await import("../../src/main/infrastructure/settings/json-settings-store.js");
    const store = createJsonSettingsStore();
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.schemaVersion).toBe(3);
      expect(loaded.value.showCompletedTodayMeetings).toBe(false);
      expect(loaded.value.openBeforeMinutes).toBe(2);
    }

    // Rewrite persisted to v3
    const { readFile } = await import("node:fs/promises");
    const rewritten = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8")) as {
      schemaVersion: number;
      showCompletedTodayMeetings?: boolean;
    };
    expect(rewritten.schemaVersion).toBe(3);
    expect(rewritten.showCompletedTodayMeetings).toBe(false);
  });

  it("round-trips explicit showCompletedTodayMeetings true across reload", async () => {
    const { createJsonSettingsStore } =
      await import("../../src/main/infrastructure/settings/json-settings-store.js");
    const store = createJsonSettingsStore();
    await store.load();
    const updated = await store.update({ showCompletedTodayMeetings: true });
    expect(updated.showCompletedTodayMeetings).toBe(true);

    const store2 = createJsonSettingsStore();
    const reloaded = await store2.load();
    expect(reloaded.ok && reloaded.value.showCompletedTodayMeetings).toBe(true);
  });

  it("ignores non-boolean showCompletedTodayMeetings on update", async () => {
    const { createJsonSettingsStore } =
      await import("../../src/main/infrastructure/settings/json-settings-store.js");
    const store = createJsonSettingsStore();
    await store.load();
    const next = await store.update({
      showCompletedTodayMeetings: "yes" as unknown as boolean,
    });
    expect(next.showCompletedTodayMeetings).toBe(false);
  });

  it("get throws before load and works after", async () => {
    const { createJsonSettingsStore } =
      await import("../../src/main/infrastructure/settings/json-settings-store.js");
    const store = createJsonSettingsStore();
    expect(() => store.get()).toThrow(/not loaded/);
    await store.load();
    expect(store.get().openBeforeMinutes).toBeDefined();
  });

  it("update merges partial quiet hours fields", async () => {
    const { createJsonSettingsStore } =
      await import("../../src/main/infrastructure/settings/json-settings-store.js");
    const store = createJsonSettingsStore();
    await store.load();
    const next = await store.update({
      quietHoursStart: "21:00",
      quietHoursEnd: "06:00",
      alertLeadSeconds: 30,
      lateJoinGraceMinutes: 5,
      nativeNotifications: false,
      autoOpenEnabled: false,
    });
    expect(next.quietHoursStart).toBe("21:00");
    expect(next.alertLeadSeconds).toBe(30);
    expect(next.lateJoinGraceMinutes).toBe(5);
  });
});
