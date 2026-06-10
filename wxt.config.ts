import { defineConfig } from "wxt";

const colonistMatches = ["https://colonist.io/*", "https://*.colonist.io/*"];

export default defineConfig({
  outDir: "output",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Colonist Stats Helper",
    description: "Captures Colonist game log entries and shows a small in-game stats overlay.",
    version: "0.1.3",
    permissions: ["storage"],
    host_permissions: colonistMatches,
    action: {
      default_title: "Colonist Stats Helper"
    },
    web_accessible_resources: [
      {
        resources: ["colonist-main-world.js"],
        matches: colonistMatches
      }
    ]
  }
});
