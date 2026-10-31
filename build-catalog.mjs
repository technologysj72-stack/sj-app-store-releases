import { writeFile } from "node:fs/promises";

const repository = String(process.env.GITHUB_REPOSITORY || "technologysj72-stack/sj-app-store-releases");
const token = String(process.env.GITHUB_TOKEN || "").trim();
const [owner, repo] = repository.split("/");
if (!owner || !repo || !token) {
  throw new Error("GITHUB_REPOSITORY ou GITHUB_TOKEN não está disponível no GitHub Actions.");
}

const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "SJ-App-Store-Catalog-Builder",
};

async function githubGet(url) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = data && typeof data === "object" ? data.message : String(data || "");
    throw new Error(`GitHub API HTTP ${response.status}: ${message || "sem detalhes"}`);
  }
  return data;
}

async function listAllPublishedReleases() {
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await githubGet(`${apiBase}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all.filter((release) => !release.draft && !release.prerelease);
}

function readStoreMetadata(body) {
  const source = String(body || "");
  const match = source.match(/<!--\s*SJ_APP_STORE\s*([\s\S]*?)\s*-->/i);
  if (!match) return null;
  try {
    const metadata = JSON.parse(match[1]);
    return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : null;
  } catch (error) {
    console.warn(`Bloco SJ_APP_STORE com JSON inválido: ${error.message}`);
    return null;
  }
}

function slugify(value) {
  return String(value || "app")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app";
}

function findInstallerAssets(assets) {
  const rules = [
    ["Android", [".apk"]],
    ["Windows", [".exe", ".msi", ".msix"]],
    ["macOS", [".dmg", ".pkg"]],
  ];
  const installers = {};
  for (const [platform, extensions] of rules) {
    const candidates = assets.filter((asset) =>
      extensions.some((extension) => String(asset.name || "").toLowerCase().endsWith(extension))
    );
    if (candidates.length) {
      const selected = candidates[0];
      installers[platform] = {
        name: selected.name,
        url: selected.browser_download_url,
        size: Number(selected.size || 0),
        downloadCount: Number(selected.download_count || 0),
        contentType: selected.content_type || "application/octet-stream",
      };
    }
  }
  return installers;
}

function findImageAsset(assets, requestedName) {
  const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
  const available = assets.filter((asset) => {
    const name = String(asset.name || "").toLowerCase();
    return imageExtensions.some((extension) => name.endsWith(extension));
  });
  if (requestedName) {
    const exact = available.find((asset) => asset.name.toLowerCase() === String(requestedName).toLowerCase());
    if (exact) return exact;
  }
  const preferred = available.find((asset) => /(logo|icon|capa|cover|image)/i.test(asset.name));
  return preferred || available[0] || null;
}

function formatSize(bytes) {
  if (!bytes) return "Tamanho não informado";
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function mapRelease(release) {
  const metadata = readStoreMetadata(release.body);
  if (!metadata) return null;

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installers = findInstallerAssets(assets);
  const platforms = Object.keys(installers);
  if (!platforms.length) {
    console.warn(`Release ${release.tag_name} ignorada: não contém APK, EXE, MSI, MSIX, DMG ou PKG.`);
    return null;
  }

  const name = String(metadata.name || release.name || release.tag_name).trim();
  const id = slugify(metadata.id || name);
  const installerSizes = Object.values(installers).reduce((sum, item) => sum + item.size, 0);
  const downloads = Object.values(installers).reduce((sum, item) => sum + item.downloadCount, 0);
  const imageAsset = findImageAsset(assets, metadata.imageAsset || metadata.logoAsset);

  return {
    id,
    name,
    category: String(metadata.category || "Aplicações"),
    shortDescription: String(metadata.shortDescription || metadata.description || ""),
    description: String(metadata.description || metadata.shortDescription || ""),
    version: String(metadata.version || release.tag_name),
    platforms,
    price: Number.isFinite(Number(metadata.priceMZN ?? metadata.price)) ? Number(metadata.priceMZN ?? metadata.price) : 0,
    rating: Number.isFinite(Number(metadata.rating)) ? Number(metadata.rating) : 0,
    downloads,
    featured: Boolean(metadata.featured),
    isNew: Boolean(metadata.isNew),
    accent: String(metadata.accent || "violet"),
    icon: String(metadata.icon || "zap"),
    developer: String(metadata.developer || "SJ Technology"),
    size: String(metadata.size || formatSize(installerSizes)),
    image: imageAsset?.browser_download_url || "",
    imageAsset: imageAsset?.name || "",
    releaseTag: release.tag_name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at || release.created_at || "",
    installers,
    source: "github",
  };
}

const releases = await listAllPublishedReleases();
const applications = releases
  .map(mapRelease)
  .filter(Boolean)
  .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository,
  applicationCount: applications.length,
  applications,
};

await writeFile("catalog.json", `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`Catálogo criado: ${applications.length} aplicação(ões) em ${repository}.`);
