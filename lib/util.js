export function normTitle(s) {
  return String(s)
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Token-overlap similarity (Jaccard on word sets) — no fuzzy-match library bundled,
// this is a deliberately simple stand-in for the rapidfuzz ratio we used server-side.
export function titleSimilarity(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const setA = new Set(na.split(" "));
  const setB = new Set(nb.split(" "));
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = new Set([...setA, ...setB]).size;
  return union ? inter / union : 0;
}

export const PROTON_ORDER = ["native", "platinum", "gold", "silver", "bronze", "borked", "pending", "unlisted"];
export const PROTON_META = {
  native:   { label: "Native",   cls: "good" },
  platinum: { label: "Platinum", cls: "good" },
  gold:     { label: "Gold",     cls: "good" },
  silver:   { label: "Silver",   cls: "caution" },
  bronze:   { label: "Bronze",   cls: "caution" },
  borked:   { label: "Borked",   cls: "reject" },
  pending:  { label: "Pending",  cls: "neutral" },
  unlisted: { label: "Unlisted", cls: "neutral" },
};

export const REVIEW_ORDER = [
  "Overwhelmingly Positive", "Very Positive", "Positive", "Mostly Positive",
  "Mixed", "Mostly Negative", "Negative", "Overwhelmingly Negative",
  "sparse", "unlisted",
];

export function reviewClass(desc) {
  if (!desc) return "neutral";
  if (/Overwhelmingly Positive|Very Positive|^Positive|Mostly Positive/.test(desc)) return "good";
  if (/Mixed/.test(desc)) return "caution";
  if (/Negative/.test(desc)) return "reject";
  return "neutral";
}
