// Plan semantics independent of the host and tree renderer.
export function validateDependencies(nodes, dependencies = {}) {
  const ids = new Set(nodes.map(n => n.id));
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw Error('Dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    const refs = dependencies[id] || [];
    if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string')) throw Error('Invalid dependencies');
    for (const ref of refs) {
      if (!ids.has(ref)) throw Error('Unknown dependency: ' + ref);
      visit(ref);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const id of ids) visit(id);
}

export function planningView(nodes, dependencies = {}, reasons = {}) {
  return nodes.map(node => {
    const dependsOn = dependencies[node.id] || [];
    const waitingFor = dependsOn.filter(id => nodes.find(n => n.id === id)?.status !== 'done');
    return {...node, dependsOn, waitingFor, blockedReason: reasons[node.id] || ''};
  });
}

export function auditChanges(before, after) {
  const changes = [];
  const prior = new Map(before.map(n => [n.id,n]));
  const next = new Map(after.map(n => [n.id,n]));
  for (const id of new Set([...prior.keys(), ...next.keys()])) {
    if (JSON.stringify(prior.get(id)) !== JSON.stringify(next.get(id))) {
      changes.push({id, before: prior.get(id) || null, after: next.get(id) || null});
    }
  }
  return changes;
}
