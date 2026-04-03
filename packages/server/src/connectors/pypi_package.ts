import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface PyPIConfig {
  packageName: string;
  includeDescription?: boolean;
}

export async function syncPyPIPackage(
  sourceId: string,
  projectId: string,
  config: PyPIConfig
) {
  const { packageName, includeDescription = true } = config;
  let indexed = 0;

  const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`);
  if (!res.ok) throw new Error(`PyPI API error: ${res.status}`);

  const data = await res.json();
  const info = data.info || {};

  const overviewLines: string[] = [
    `# ${info.name || packageName}`,
    info.summary ? `\n${info.summary}` : "",
    `\n**Version:** ${info.version || "unknown"}`,
    info.license ? `**License:** ${info.license}` : "",
    info.author ? `**Author:** ${info.author}` : "",
    info.author_email ? `**Author Email:** ${info.author_email}` : "",
    info.home_page ? `**Homepage:** ${info.home_page}` : "",
    info.project_urls?.Documentation ? `**Docs:** ${info.project_urls.Documentation}` : "",
    info.project_urls?.Repository || info.project_urls?.Source
      ? `**Repository:** ${info.project_urls.Repository || info.project_urls.Source}`
      : "",
    info.requires_python ? `**Python:** ${info.requires_python}` : "",
    info.keywords ? `**Keywords:** ${info.keywords}` : "",
  ].filter(Boolean);

  // Classifiers — extract useful info (programming language, framework, topic)
  if (info.classifiers?.length) {
    const topics = info.classifiers
      .filter((c: string) => c.startsWith("Topic ::") || c.startsWith("Framework ::") || c.startsWith("Intended Audience ::"))
      .slice(0, 10);
    if (topics.length > 0) {
      overviewLines.push("\n## Classifiers");
      for (const t of topics) overviewLines.push(`- ${t}`);
    }
  }

  // Extras
  if (info.provides_extra?.length) {
    overviewLines.push(`\n**Extras:** ${info.provides_extra.join(", ")}`);
  }

  const overviewContent = overviewLines.join("\n");
  const overviewTitle = `${packageName} — Overview`;

  // Synthesis
  const synthesis = await synthesizeDocument(overviewContent, "pypi_package", overviewTitle, {
    package: packageName,
    version: info.version || "",
    license: info.license || "",
    language: "Python",
  });
  if (synthesis) {
    await ingestDocument({
      sourceId,
      projectId,
      externalId: `pypi-${packageName}-overview#synthesis`,
      title: `${packageName} — Package Overview`,
      content: formatSynthesis(synthesis, overviewTitle),
      metadata: { source: "pypi", source_type: "pypi", packageName, version: info.version, section: "synthesis", is_synthesis: true },
      sourceType: "pypi",
    });
    indexed++;
  }

  await ingestDocument({
    sourceId,
    projectId,
    externalId: `pypi-${packageName}-overview`,
    title: overviewTitle,
    content: overviewContent,
    metadata: { source: "pypi", source_type: "pypi", packageName, version: info.version, section: "overview" },
    sourceType: "pypi",
  });
  indexed++;

  // Dependencies
  if (info.requires_dist?.length) {
    const coreDeps = info.requires_dist.filter((d: string) => !d.includes("extra =="));
    if (coreDeps.length > 0) {
      await ingestDocument({
        sourceId,
        projectId,
        externalId: `pypi-${packageName}-deps`,
        title: `${packageName} — Dependencies`,
        content: `# ${packageName} Dependencies\n\n${coreDeps.map((d: string) => `- ${d}`).join("\n")}`,
        metadata: { source: "pypi", source_type: "pypi", packageName, section: "dependencies" },
        sourceType: "pypi",
      });
      indexed++;
    }
  }

  // Full description (README from PyPI)
  if (includeDescription && info.description && info.description.length > 50) {
    await ingestDocument({
      sourceId,
      projectId,
      externalId: `pypi-${packageName}-description`,
      title: `${packageName} — Description`,
      content: info.description,
      metadata: {
        source: "pypi",
        source_type: "pypi",
        packageName,
        section: "description",
        contentType: info.description_content_type || "text/plain",
      },
      sourceType: "pypi",
    });
    indexed++;
  }

  generateSourceProfile(sourceId, projectId, {
    sourceType: "pypi_package",
    rootUrl: `https://pypi.org/project/${packageName}`,
  }).catch(() => {});

  return { documentsIndexed: indexed };
}
