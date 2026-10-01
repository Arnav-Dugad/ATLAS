/**
 * The second globe of the side-by-side comparison: imagery only (the "before" date), with its
 * camera locked to the main globe's. Whichever globe the user last touched drives the other, so
 * dragging, zooming and tilting either side moves both.
 */
import { Cartesian3, CesiumWidget, Color, EllipsoidTerrainProvider, ImageryLayer, Matrix4, UrlTemplateImageryProvider } from "cesium";
import type { AtlasGlobe } from "./AtlasGlobe";
import { BASE, BASE_FALLBACK, compareUrl, type CompareProduct } from "./imagery";

function sameView(a: Matrix4, b: Matrix4): boolean {
  return Matrix4.equalsEpsilon(a, b, 1e-9);
}

export class TwinGlobe {
  readonly widget: CesiumWidget;
  private layer: ImageryLayer | null = null;
  private key = "";
  private driver: "main" | "twin" = "main";
  private lastMain = new Matrix4();
  private lastTwin = new Matrix4();
  private off: (() => void)[] = [];

  constructor(container: HTMLElement, private main: AtlasGlobe) {
    const credits = document.createElement("div");
    credits.style.display = "none";
    const dpr = window.devicePixelRatio || 1;
    this.widget = new CesiumWidget(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      scene3DOnly: true,
      creditContainer: credits,
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      useBrowserRecommendedResolution: false,
      msaaSamples: 1,
    });
    this.widget.resolutionScale = main.renderProfile === "light" ? 1 / dpr : Math.min(1, 2 / dpr);
    const scene = this.widget.scene;
    scene.backgroundColor = Color.fromCssColorString("#04060a");
    scene.globe.baseColor = Color.fromCssColorString("#0b1724");
    scene.globe.enableLighting = false;
    scene.globe.showGroundAtmosphere = true;
    scene.globe.maximumScreenSpaceError = main.renderProfile === "light" ? 3 : 1.6;
    if (scene.moon) scene.moon.show = false;
    if (scene.sun) scene.sun.show = false;
    const ctrl = scene.screenSpaceCameraController;
    ctrl.minimumZoomDistance = 2_500;
    ctrl.maximumZoomDistance = 45_000_000;
    for (const def of [BASE_FALLBACK, BASE]) {
      this.widget.imageryLayers.add(
        new ImageryLayer(new UrlTemplateImageryProvider({ url: def.url(""), maximumLevel: def.maximumLevel, enablePickFeatures: false })),
      );
    }

    const mainScene = main.widget.scene;
    const take = (who: "main" | "twin") => () => {
      this.driver = who;
    };
    const mainCanvas = mainScene.canvas;
    const twinCanvas = scene.canvas;
    const onMain = take("main");
    const onTwin = take("twin");
    mainCanvas.addEventListener("pointerdown", onMain);
    mainCanvas.addEventListener("wheel", onMain, { passive: true });
    twinCanvas.addEventListener("pointerdown", onTwin);
    twinCanvas.addEventListener("wheel", onTwin, { passive: true });
    this.off.push(() => {
      mainCanvas.removeEventListener("pointerdown", onMain);
      mainCanvas.removeEventListener("wheel", onMain);
      twinCanvas.removeEventListener("pointerdown", onTwin);
      twinCanvas.removeEventListener("wheel", onTwin);
    });

    // Copy the driving camera after each of its frames (both scenes render on demand, so this
    // runs only while something moves).
    const fromMain = () => {
      if (this.driver !== "main" || sameView(mainScene.camera.viewMatrix, this.lastMain)) return;
      Matrix4.clone(mainScene.camera.viewMatrix, this.lastMain);
      this.copy(mainScene.camera, scene.camera);
      Matrix4.clone(scene.camera.viewMatrix, this.lastTwin);
      scene.requestRender();
    };
    const fromTwin = () => {
      if (this.driver !== "twin" || sameView(scene.camera.viewMatrix, this.lastTwin)) return;
      Matrix4.clone(scene.camera.viewMatrix, this.lastTwin);
      this.copy(scene.camera, mainScene.camera);
      Matrix4.clone(mainScene.camera.viewMatrix, this.lastMain);
      mainScene.requestRender();
    };
    this.off.push(mainScene.postRender.addEventListener(fromMain));
    this.off.push(scene.postRender.addEventListener(fromTwin));
    this.copy(mainScene.camera, scene.camera);
  }

  private copy(from: CesiumWidget["camera"], to: CesiumWidget["camera"]) {
    to.setView({
      destination: Cartesian3.clone(from.positionWC),
      orientation: { direction: Cartesian3.clone(from.directionWC), up: Cartesian3.clone(from.upWC) },
    });
  }

  setImagery(product: CompareProduct, date: string) {
    const key = `${product.id}|${date}`;
    if (key === this.key) return;
    this.key = key;
    if (this.layer) this.widget.imageryLayers.remove(this.layer, true);
    this.layer = new ImageryLayer(new UrlTemplateImageryProvider({ url: compareUrl(product, date), maximumLevel: product.level, enablePickFeatures: false }));
    this.widget.imageryLayers.add(this.layer);
    this.widget.scene.requestRender();
  }

  destroy() {
    for (const f of this.off) f();
    this.off = [];
    if (!this.widget.isDestroyed()) {
      this.widget.useDefaultRenderLoop = false;
      this.widget.destroy();
    }
    this.main.requestRender();
  }
}
