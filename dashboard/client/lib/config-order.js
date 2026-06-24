export function groupKeyForConfigChoice(item = {}) {
  return String(item.groupKey || item.label || item.id || item.path || "").trim();
}

function blockIdsForItem(items = [], index, grouped = false) {
  const item = items[index];
  if (!item) return new Set();
  if (!grouped) return new Set([item.id]);
  const groupKey = groupKeyForConfigChoice(item);
  return new Set(
    items
      .filter((candidate) => groupKeyForConfigChoice(candidate) === groupKey)
      .map((candidate) => candidate.id)
  );
}

export function moveConfigChoice(items = [], index, direction, { grouped = false } = {}) {
  const blockIds = blockIdsForItem(items, index, grouped);
  if (!blockIds.size) return items;
  const blockIndexes = items
    .map((item, itemIndex) => (blockIds.has(item.id) ? itemIndex : -1))
    .filter((itemIndex) => itemIndex >= 0);
  const boundaryIndex = direction < 0 ? Math.min(...blockIndexes) : Math.max(...blockIndexes);
  const targetIndex = boundaryIndex + direction;
  if (targetIndex < 0 || targetIndex >= items.length || blockIds.has(items[targetIndex]?.id)) return items;

  const block = items.filter((item) => blockIds.has(item.id));
  const remaining = items.filter((item) => !blockIds.has(item.id));
  const target = items[targetIndex];
  const targetGroupKey = grouped ? groupKeyForConfigChoice(target) : "";
  const targetIndexes = remaining
    .map((item, itemIndex) => (
      grouped && groupKeyForConfigChoice(item) === targetGroupKey
        ? itemIndex
        : item.id === target.id
          ? itemIndex
          : -1
    ))
    .filter((itemIndex) => itemIndex >= 0);
  if (!targetIndexes.length) return items;
  const insertAt = direction < 0 ? Math.min(...targetIndexes) : Math.max(...targetIndexes) + 1;
  return [
    ...remaining.slice(0, insertAt),
    ...block,
    ...remaining.slice(insertAt),
  ];
}

export function reorderConfigChoice(items = [], fromIndex, toIndex, { grouped = false } = {}) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return items;
  }
  const blockIds = blockIdsForItem(items, fromIndex, grouped);
  if (!blockIds.size || blockIds.has(items[toIndex]?.id)) return items;
  const block = items.filter((item) => blockIds.has(item.id));
  const remaining = items.filter((item) => !blockIds.has(item.id));
  const target = items[toIndex];
  const targetGroupKey = grouped ? groupKeyForConfigChoice(target) : "";
  const targetIndexes = remaining
    .map((item, itemIndex) => (
      grouped && groupKeyForConfigChoice(item) === targetGroupKey
        ? itemIndex
        : item.id === target.id
          ? itemIndex
          : -1
    ))
    .filter((itemIndex) => itemIndex >= 0);
  if (!targetIndexes.length) return items;
  const insertAt = Math.min(...targetIndexes);
  return [
    ...remaining.slice(0, insertAt),
    ...block,
    ...remaining.slice(insertAt),
  ];
}
