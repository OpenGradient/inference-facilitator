import express from "express";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = express();
const port = Number(process.env.PORT || 4173);
const serverFilePath = fileURLToPath(import.meta.url);
const testServerDir = path.dirname(serverFilePath);
const rootDir = path.resolve(testServerDir, "..");
const walrusDistEntry = path.join(
  rootDir,
  "dist",
  "esm",
  "index.mjs",
);

app.use(express.static(rootDir, { index: false }));

app.get("/", (_req, res) => {
  res.redirect("/testserver/walrus_test_page.html");
});

app.listen(port, () => {
  console.log(
    `[walrus-test-page] listening on http://localhost:${port}/testserver/walrus_test_page.html`,
  );
  if (!fs.existsSync(walrusDistEntry)) {
    console.warn(
      "[walrus-test-page] Walrus package build is missing. Run `pnpm build` in this package before opening the page.",
    );
  }
});
