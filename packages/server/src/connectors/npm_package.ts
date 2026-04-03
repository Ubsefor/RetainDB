import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface NpmConfig {
  packageName: string;
  includeReadme?: boolean;
}

export async function syncNpmPackage(
  sourceId: string,
  projectId: string,
  config: NpmConfig
) {
  const { packageName, includeReadme = true } = config;
  let indexed = 0;

  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
  if (!res.ok) throw new Error(`npm registry error: ${res.status}`);

  const pkg = await res.json();
  const latest = pkg["dist-tags"]?.latest;
  const v = latest ? pkg.versions?.[latest] : null;

  const overviewLines: string[] = [
    `# ${packageName}`,
    pkg.description ? `\n${pkg.description}` : "",
    `\n**Version:** ${latest || "unknown"}`,
    pkg.license ? `**License:** ${pkg.license}` : "",
    pkg.homepage ? `**Homepage:** ${pkg.homepage}` : "",
    pkg.repository?.url ? `**Repository:** ${pkg.repository.url}` : "",
    v?.keywords?.length ? `**Keywords:** ${v.keywords.join(", ")}` : "",
    v?.engines?.node ? `**Node.js:** ${v.engines.node}` : "",
  ].filter(Boolean);

  // Entry points
  if (v?.main || v?.types || v?.exports || v?.module) {
    overviewLines.push("\n## Entry Points");
    if (v.main) overviewLines.push(`- **main:** \`${v.main}\``);
    if (v.module) overviewLines.push(`- **module:** \`${v.module}\``);
    if (v.types) overviewLines.push(`- **types:** \`${v.types}\``);
    if (v.exports && typeof v.exports === "object") {
      overviewLines.push(`- **exports:** ${Object.keys(v.exports).slice(0, 8).join(", ")}`);
    }
  }

  // Peer dependencies
  if (v?.peerDependencies && Object.keys(v.peerDependencies).length > 0) {
    overviewLines.push("\n## Peer Dependencies");
    for (const [name, ver] of Object.entries(v.peerDependencies)) {
      overviewLines.push(`- \`${name}\`: ${ver}`);
    }
  }

  // Dependencies
  if (v?.dependencies && Object.keys(v.dependencies).length > 0) {
    const depLines = Object.entries(v.dependencies)
      .map(([name, ver]) => `- \`${name}\`: ${ver}`)
      .join("\n");
    await ingestDocument({
      sourceId,
      projectId,
      externalId: `npm-${packageName}-deps`,
      title: `${packageName} — Dependencies`,
      content: `# ${packageName} Dependencies\n\n${depLines}`,
      metadata: { source: "npm", source_type: "npm", packageName, version: latest, section: "dependencies" },
      sourceType: "npm",
    });
    indexed++;
  }

  const overviewContent = overviewLines.join("\n");
  const overviewTitle = `${packageName} — Overview`;

  // Synthesis
  const synthesis = await synthesizeDocument(overviewContent, "npm_package", overviewTitle, {
    package: packageName,
    version: latest || "",
    license: pkg.license || "",
  });
  if (synthesis) {
    await ingestDocument({
      sourceId,
      projectId,
      externalId: `npm-${packageName}-overview#synthesis`,
      title: `${packageName} — Package Overview`,
      content: formatSynthesis(synthesis, overviewTitle),
      metadata: { source: "npm", source_type: "npm", packageName, version: latest, section: "synthesis", is_synthesis: true },
      sourceType: "npm",
    });
    indexed++;
  }

  await ingestDocument({
    sourceId,
    projectId,
    externalId: `npm-${packageName}-overview`,
    title: overviewTitle,
    content: overviewContent,
    metadata: { source: "npm", source_type: "npm", packageName, version: latest, section: "overview" },
    sourceType: "npm",
  });
  indexed++;

  // README
  if (includeReadme && pkg.readme && pkg.readme.length > 50) {
    await ingestDocument({
      sourceId,
      projectId,
      externalId: `npm-${packageName}-readme`,
      title: `${packageName} — README`,
      content: pkg.readme,
      metadata: { source: "npm", source_type: "npm", packageName, version: latest, section: "readme" },
      sourceType: "npm",
    });
    indexed++;
  }

  generateSourceProfile(sourceId, projectId, {
    sourceType: "npm_package",
    rootUrl: `https://www.npmjs.com/package/${packageName}`,
  }).catch(() => {});

  return { documentsIndexed: indexed };
}
