import type { Page } from "playwright";

// TEST ONLY: selectors stay inside the browser; never emit text, IDs or URLs.
export async function diagnoseLinkWait(
  page: Page,
  kind: "kb-drop" | "integration-preview",
  source: string,
  result: string,
  action: () => Promise<void>,
  emit = (record: unknown) => console.log(JSON.stringify(record)),
  dropOffset?: { x: number; y: number },
) {
  const key = "__linkWaitDiagnostic";
  const bounded = <T>(work: Promise<T>) =>
    Promise.race([
      work,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
  try {
    try {
      await page.evaluate(
        ({ key, source, result, dropOffset }) => {
          const counts = {
            pointerReached: 0,
            dragstart: 0,
            canvasDrop: 0,
            drag: 0,
            dragend: 0,
            canvasDragover: 0,
            resultGenerated: false,
            resultVisible: false,
          };
          const hitKind = (element: Element | null) => {
            for (const [selector, kind] of [
              [".concept-node", "concept"],
              [".link-connector", "connector"],
              [".kit-palette-part", "palette"],
              [".map-editor-drawer", "drawer"],
              ["[role=dialog]", "dialog"],
              [".concept-canvas", "canvas"],
            ])
              if (element?.closest(selector)) return kind;
            if (!element) return "none";
          const tag=element.tagName.toUpperCase();
          return ["BUTTON","INPUT","DIV","SVG","PATH","HEADER","ASIDE","SECTION","SPAN"].includes(tag)?"other-"+tag.toLowerCase():"other";
          };
          const destination = () => {
            const canvas = document.querySelector(".concept-canvas");
            if (!canvas) return null;
            const b = canvas.getBoundingClientRect(),
              css = getComputedStyle(canvas);
            const rect = { x: b.x, y: b.y, width: b.width, height: b.height };
            const x =
                b.x +
                parseFloat(css.borderLeftWidth || "0") +
                (dropOffset?.x ?? 0),
              y =
                b.y +
                parseFloat(css.borderTopWidth || "0") +
                (dropOffset?.y ?? 0);
            return {
              canvas: rect,
              point: dropOffset
                ? {
                    x,
                    y,
                    inViewport:
                      x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
                    hit: hitKind(document.elementFromPoint(x, y)),
                  }
                : null,
            };
          };
          const samples: unknown[] = [];
          let last: unknown = null;
          const initialDestination = destination();
          const handler = (event: Event) => {
            const target = event.target,
              element = document.querySelector(source);
            if (!(target instanceof Element)) return;
            if (event.type === "pointerdown" && element?.contains(target))
              counts.pointerReached++;
            if (event.type === "dragstart" && element?.contains(target))
              counts.dragstart++;
            if (event.type === "drag") counts.drag++;
            if (event.type === "dragend") counts.dragend++;
            if (event.type === "dragover" && target.closest(".concept-canvas"))
              counts.canvasDragover++;
            if (
              [
                "dragstart",
                "drag",
                "dragenter",
                "dragover",
                "drop",
                "dragend",
              ].includes(event.type)
            ) {
              const e = event as DragEvent;
              last = {
                type: event.type,
                x: e.clientX,
                y: e.clientY,
                target: hitKind(target),
                hit: hitKind(document.elementFromPoint(e.clientX, e.clientY)),
                dropEffect: ["none", "copy", "move", "link"].includes(
                  e.dataTransfer?.dropEffect ?? "",
                )
                  ? e.dataTransfer?.dropEffect
                  : null,
              };
              if (samples.length < 12) samples.push(last);
            }
            if (event.type === "drop" && target.closest(".concept-canvas"))
              counts.canvasDrop++;
          };
          const observe = () => {
            const e = document.querySelector(result);
            if (e) {
              counts.resultGenerated = true;
              const b = e.getBoundingClientRect();
              counts.resultVisible ||=
                b.width > 0 &&
                b.height > 0 &&
                getComputedStyle(e).visibility !== "hidden";
            }
          };
          const observer = new MutationObserver(observe);
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
          });
          observe();
          (window as unknown as Record<string, unknown>)[key] = {
            counts,
            handler,
            observer,
            detail: () => ({
              samples,
              last,
              initialDestination,
              currentDestination: destination(),
            }),
          };
          for (const type of [
            "pointerdown",
            "dragstart",
            "drag",
            "dragend",
            "dragenter",
            "dragover",
            "drop",
          ])
            window.addEventListener(type, handler, {
              capture: true,
              passive: true,
            });
        },
        { key, source, result, dropOffset },
      );
    } catch {
      /* Diagnostic setup must not suppress the actual operation. */
    }
    await action();
  } catch (original) {
    try {
      const state = await bounded(
        page.evaluate(
          ({ key, source, result }) => {
            const inspect = (selector: string) => {
              const elements = [...document.querySelectorAll(selector)];
              return {
                count: elements.length,
                elements: elements.slice(0, 4).map((element) => {
                  const b = element.getBoundingClientRect(),
                    style = getComputedStyle(element);
                  const visible =
                    b.width > 0 &&
                    b.height > 0 &&
                    style.visibility !== "hidden" &&
                    style.display !== "none";
                  const hit = document.elementFromPoint(
                    b.x + b.width / 2,
                    b.y + b.height / 2,
                  );
                  return {
                    x: b.x,
                    y: b.y,
                    width: b.width,
                    height: b.height,
                    visible,
                    inViewport:
                      b.right > 0 &&
                      b.bottom > 0 &&
                      b.left < innerWidth &&
                      b.top < innerHeight,
                    centerHit: !!hit && element.contains(hit),
                  };
                }),
              };
            };
            const state = (
              window as unknown as Record<
                string,
                { counts: unknown; detail: () => unknown }
              >
            )[key];
            return {
              events: state?.counts ?? null,
              dragDetail: state?.detail?.() ?? null,
              viewport: { width: innerWidth, height: innerHeight },
              source: inspect(source),
              result: inspect(result),
            };
          },
          { key, source, result },
        ),
      );
      emit({ check: kind, state });
    } catch {
      /* Preserve the original verification exception, including output failure. */
    }
    throw original;
  } finally {
    try {
      await bounded(
        page.evaluate((key) => {
          const w = window as unknown as Record<
            string,
            { handler: EventListener; observer: MutationObserver }
          >;
          if (w[key])
            for (const type of [
              "pointerdown",
              "dragstart",
              "drag",
              "dragend",
              "dragenter",
              "dragover",
              "drop",
            ])
              window.removeEventListener(type, w[key].handler, true);
          w[key]?.observer.disconnect();
          delete w[key];
        }, key),
      );
    } catch {
      /* Cleanup must not replace original failure. */
    }
  }
}
