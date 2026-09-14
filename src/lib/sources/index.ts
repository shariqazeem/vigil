/**
 * Vigil's ground-truth data layer: five keyless US federal sources behind one shape.
 *
 *   nhtsa-recalls     api.nhtsa.gov/recalls/recallsByVehicle · /recalls/campaignNumber
 *   nhtsa-complaints  api.nhtsa.gov/complaints/complaintsByVehicle
 *   nhtsa-vpic        vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues
 *   cpsc-recalls      saferproducts.gov/RestWebServices/Recall
 *   openfda           api.fda.gov/{food,drug,device}/enforcement.json
 *
 * Every function returns `SourceResult<T>`: the exact URL it called, whether the source actually
 * answered, the rows it gave, and when. Nothing throws; nothing that failed is reported as clean.
 */
export * from "./types";
export * from "./http";
export * from "./nhtsa";
export * from "./cpsc";
export * from "./openfda";

import type { SourceName } from "./types";

/** What the UI prints beside a row, and where a person can go to check it themselves. */
export const SOURCE_LABELS: Record<SourceName, { label: string; agency: string; docs: string }> = {
  "nhtsa-recalls": {
    label: "NHTSA safety recalls",
    agency: "National Highway Traffic Safety Administration",
    docs: "https://api.nhtsa.gov/",
  },
  "nhtsa-complaints": {
    label: "NHTSA owner complaints (ODI)",
    agency: "National Highway Traffic Safety Administration",
    docs: "https://api.nhtsa.gov/",
  },
  "nhtsa-vpic": {
    label: "NHTSA vPIC VIN decode",
    agency: "National Highway Traffic Safety Administration",
    docs: "https://vpic.nhtsa.dot.gov/api/",
  },
  "cpsc-recalls": {
    label: "CPSC product recalls",
    agency: "Consumer Product Safety Commission",
    docs: "https://www.saferproducts.gov/RestWebServices",
  },
  openfda: {
    label: "openFDA enforcement reports",
    agency: "Food and Drug Administration",
    docs: "https://open.fda.gov/apis/",
  },
};
