/** India regional view helpers: where to look, and the season by IMD's climatological calendar. */
export const INDIA_VIEW = { lat: 22.5, lon: 80.5, height: 5_200_000 };
export const INDIA_BBOX: [number, number, number, number] = [68, 6, 97.5, 37.5];

/**
 * What the climatological calendar says about this time of year (IMD normals). This is the
 * usual pattern, not this year's observed monsoon status, and the UI labels it so.
 */
export function seasonFor(date: Date): { season: string; detail: string } {
  const m = date.getUTCMonth() + 1;
  if (m >= 6 && m <= 9) {
    return {
      season: "Southwest monsoon (June–September)",
      detail: "The main rainy season: river floods, landslides in the Himalaya and Western Ghats, and urban flooding are most likely.",
    };
  }
  if (m >= 10) {
    return {
      season: "Post-monsoon (October–December)",
      detail:
        "The southwest monsoon normally withdraws by mid-October; the northeast monsoon brings rain to Tamil Nadu, Puducherry, coastal Andhra Pradesh and south interior Karnataka. Bay of Bengal cyclones peak in October–November.",
    };
  }
  if (m >= 3) {
    return {
      season: "Pre-monsoon / hot weather (March–May)",
      detail: "Heatwaves over north, central and east India; severe thunderstorms and lightning; cyclones possible in the Bay of Bengal and Arabian Sea from April.",
    };
  }
  return {
    season: "Winter (January–February)",
    detail: "Cold waves and dense fog over north India; western disturbances bring snow and rain to the Himalaya.",
  };
}

export function inIndia(i: { country_iso3: string | null }): boolean {
  return i.country_iso3 === "IND";
}
