// Sets the Compu-Cart icon and version info on the packaged Windows exe (pure JS, no Wine).
// Usage: node stamp-exe.mjs <exe> <icon.ico> <version> <resedit-dir>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [exe, iconPath, version, reseditDir] = process.argv.slice(2);
const ResEdit = await import(pathToFileURL(path.join(reseditDir, "dist/index.js")).href);
const data = fs.readFileSync(exe);
const image = ResEdit.NtExecutable.from(data, { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(image);
const icon = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const iconId = groups[0]?.id ?? 1;
const lang = groups[0]?.lang ?? 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, iconId, lang, icon.icons.map((i) => i.data));
const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const [major, minor, patch] = version.split(".").map(Number);
vi.setFileVersion(major, minor, patch, 0, 1033);
vi.setProductVersion(major, minor, patch, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  ProductName: "Compu-Cart",
  FileDescription: "Compu-Cart — console de cartouches",
  CompanyName: "Compu-Cart",
  OriginalFilename: "Compu-Cart.exe",
  InternalName: "Compu-Cart",
  LegalCopyright: "",
  FileVersion: version,
  ProductVersion: version,
});
vi.outputToResourceEntries(res.entries);
res.outputResource(image);
fs.writeFileSync(exe, Buffer.from(image.generate()));
console.log("stamped", exe);
