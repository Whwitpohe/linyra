// The extension host requires this module and calls run().
import * as fs from "fs";
import * as path from "path";
import Mocha = require("mocha");

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60000 });
  // The suites share one workspace, so their order is fixed: the Log's own suite, then the ones
  // split out of it, as when they were one file. Any other suite runs after them, by name.
  const order = ["branches", "log", "compare", "combined", "multiRepo", "commitActions"];
  const rank = (file: string) => {
    const i = order.indexOf(file.replace(/\.itest\.js$/, ""));
    return i < 0 ? order.length : i;
  };
  const files = fs.readdirSync(__dirname).filter((file) => file.endsWith(".itest.js"));
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const file of files) mocha.addFile(path.join(__dirname, file));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} failing`)) : resolve()));
  });
}
