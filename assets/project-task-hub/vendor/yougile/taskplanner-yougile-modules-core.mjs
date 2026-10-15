// Product modules are defined by the target repository, never by this template.
export function classifyTaskModule(task, config) {
  const modules = config.modules || [];
  if (!modules.length) return { module: null, matches: [], ambiguous: false };

  const byKey = new Map(modules.map((item) => [item.key, item]));
  if (byKey.size !== modules.length || modules.some((item) => !item.key || !item.name)) {
    throw new Error("Each module needs a unique key and a name");
  }
  const overrideKey = config.moduleOverrides?.[task.id];
  if (overrideKey) {
    const module = byKey.get(overrideKey);
    if (!module) throw new Error(`Unknown module override for ${task.id}: ${overrideKey}`);
    return { module, matches: [module], ambiguous: false, source: "override" };
  }

  const tags = new Set((task.tags || []).map((tag) => tag.toLocaleLowerCase()));
  const title = task.title.toLocaleLowerCase();
  const matches = modules.filter((module) =>
    (module.tags || []).some((tag) => tags.has(tag.toLocaleLowerCase())) ||
    (module.keywords || []).some((word) => title.includes(word.toLocaleLowerCase())),
  );
  if (matches.length) {
    return { module: matches[0], matches, ambiguous: matches.length > 1, source: "rule" };
  }
  const fallback = byKey.get(config.moduleFallback);
  if (!fallback) throw new Error("Configure moduleFallback for tasks without a module match");
  return { module: fallback, matches: [], ambiguous: false, source: "fallback" };
}
