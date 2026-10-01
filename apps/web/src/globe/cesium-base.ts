// Must run before CesiumJS is imported: tells Cesium where its workers and assets live.
declare const CESIUM_BASE_URL: string;
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL =
  typeof CESIUM_BASE_URL === "string" ? CESIUM_BASE_URL : `${import.meta.env.BASE_URL}cesium`;
