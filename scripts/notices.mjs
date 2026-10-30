import { execFileSync } from "node:child_process";
import { readFile, readdir, mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname, resolve, relative, join } from "node:path";

// License text comes from locked dependency sources, never invented holder claims.
const root = resolve(import.meta.dirname, "..");
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version=1"], { cwd: root, maxBuffer: 20 * 1024 * 1024 }).toString());
const outputs = new Map();
const components = [];
async function collect(kind, name, version, license, directory, source, explicit) {
  const prefix = `${kind}/${name.replaceAll("/", "_")}-${version}`;
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(licen[sc]e|copying|notice)([._-]|$)/i.test(entry.name)) files.push(entry.name);
  }
  if (explicit) {
    const file = relative(directory, resolve(directory, explicit));
    if (file.startsWith("..")) throw new Error(`License path escapes package: ${name}`);
    if (!files.includes(file)) files.push(file);
  }
  for (const file of files.sort()) outputs.set(`${prefix}/${file}`, await readFile(join(directory, file)));
  components.push({ ecosystem: kind, name, version, license, source, notices: files.map((f) => `${prefix}/${f}`) });
}
for (const pkg of metadata.packages.filter((p) => p.source)) {
  await collect("rust", pkg.name, pkg.version, pkg.license, dirname(pkg.manifest_path), pkg.source, pkg.license_file);
}
const allowed = new Set(["MIT-0", "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "CC0-1.0", "BlueOak-1.0.0", "MIT OR Apache-2.0", "(MIT OR Apache-2.0)", "MIT AND BSD-3-Clause", "MIT AND Zlib", "Python-2.0", "Unlicense"]);
async function npmDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) { await npmDirectory(join(directory, entry.name)); continue; }
    const location = join(directory, entry.name);
    let pkg;
    try { pkg = JSON.parse(await readFile(join(location,"package.json"),"utf8")); } catch { continue; }
    const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
    // Unmodified Lightning CSS is MPL-2.0 build tooling, not linked into the shipped UI.
    const buildOnlyMpl = license === "MPL-2.0" && (pkg.name === "lightningcss" || pkg.name.startsWith("lightningcss-"));
    if (!allowed.has(license) && !buildOnlyMpl) throw new Error(`Unreviewed npm license: ${pkg.name}@${pkg.version}: ${license}`);
    await collect("npm",pkg.name,pkg.version,license,location,pkg.repository?.url ?? pkg.homepage ?? "npm registry");
    try { await npmDirectory(join(location,"node_modules")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
await npmDirectory(join(root,"frontend/node_modules"));
components.sort((a,b) => `${a.ecosystem}/${a.name}/${a.version}`.localeCompare(`${b.ecosystem}/${b.name}/${b.version}`,"en"));
outputs.set("components.json",Buffer.from(`${JSON.stringify(components,null,2)}\n`));
outputs.set("README.md",Buffer.from("# Third-party notices\n\nGenerated from Cargo.lock and the installed frontend lockfile by node scripts/notices.mjs. Includes build/test dependencies as well as runtime components. Original NavarchNet code remains Apache-2.0; these dependencies retain the licenses recorded in components.json. Full available upstream license/NOTICE texts are preserved in ecosystem/package-version directories. Components without a top-level notice file retain their SPDX metadata and source reference; inspect upstream sources before adding distribution obligations. Do not edit generated notices.\n"));
const check = process.argv.includes("--check");
async function existingFiles(directory,prefix = "") {
  let entries;
  try { entries = await readdir(directory,{ withFileTypes:true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in generated notices: ${file}`);
    if (entry.isDirectory()) files.push(...await existingFiles(join(directory,entry.name),file));
    else files.push(file);
  }
  return files;
}
for (const file of await existingFiles(join(root,"third-party"))) {
  if (!outputs.has(file)) {
    if (check) throw new Error(`Obsolete generated notice: ${file}`);
    await unlink(join(root,"third-party",file));
  }
}
for (const [file,content] of outputs) {
  const target = join(root,"third-party",file);
  if (check) {
    const existing = await readFile(target);
    if (!existing.equals(content)) throw new Error(`Third-party notices drift: ${file}`);
  } else { await mkdir(dirname(target),{ recursive:true }); await writeFile(target,content); }
}
console.log(JSON.stringify({ result:"pass",mode:check ? "check" : "generate",components:components.length,notice_files:outputs.size }));
