/**
 * Marker embedded in every drift report so a provider can find the comment
 * it posted last time and update it in place, instead of adding a new one on
 * every CI run. Lives outside core/ and providers/ because both need it and
 * neither should depend on the other.
 */
export const REPORT_MARKER = "<!-- handoverkit:report -->";
