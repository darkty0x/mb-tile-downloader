export function eventRecordId(event = {}) {
  return event.id || event.eventId || null;
}

export function eventNotificationId(event = {}, index = 0) {
  const durableId = eventRecordId(event);
  return `event-${durableId || `${event.createdAt || ""}-${event.type || ""}-${event.message || ""}` || index}`;
}
