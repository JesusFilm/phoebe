import { describe, expect, test } from "vite-plus/test";
import { SETTING_COPY, settingCopy } from "./config-copy.ts";
import { SETTINGS } from "../../../src/settings-catalogue.ts";

describe("the words beside each setting", () => {
  test("every setting the form can offer has a name and a sentence", () => {
    const offered = SETTINGS.filter(
      (setting) => setting.envOnly !== true && !setting.path.includes("."),
    );
    for (const setting of offered) {
      const copy = SETTING_COPY[setting.path];
      expect(copy, setting.path).toBeDefined();
      expect(copy!.label.length, setting.path).toBeGreaterThan(0);
      expect(copy!.description.length, setting.path).toBeGreaterThan(0);
    }
  });

  test("the deployment's rows have them too", () => {
    for (const path of ["engine.ref", "reporting.maintainers", "workspace.depth"]) {
      expect(SETTING_COPY[path], path).toBeDefined();
    }
  });

  test("a path with no words is its own name, and says nothing more", () => {
    expect(settingCopy("somethingNew")).toEqual({ label: "somethingNew", description: "" });
  });
});
