import type { Page } from "playwright";

// TEST ONLY: selectors stay inside the browser; never emit text, IDs or URLs.
export async function diagnoseLinkWait(
  page: Page,
  kind: "kb-drop" | "integration-preview",
  source: string,
  result: string,
  action: () => Promise<void>,
  emit = (record: unknown) => console.log(JSON.stringify(record)),
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
      ({ key, source, result }) => {
        const counts = {
          pointerReached: 0,
          dragstart: 0,
          canvasDrop: 0,
          resultGenerated: false,
          resultVisible: false,
        };
        const handler = (event: Event) => {
          const target = event.target,
            element = document.querySelector(source);
          if (!(target instanceof Element)) return;
          if (event.type === "pointerdown" && element?.contains(target))
            counts.pointerReached++;
          if (event.type === "dragstart" && element?.contains(target))
            counts.dragstart++;
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
        };
        for (const type of ["pointerdown", "dragstart", "drop"])
          window.addEventListener(type, handler, true);
      },
      { key, source, result },
    );
    } catch { /* Diagnostic setup must not suppress the actual operation. */ }
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
              window as unknown as Record<string, { counts: unknown }>
            )[key];
            return {
              events: state?.counts ?? null,
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
            for (const type of ["pointerdown", "dragstart", "drop"])
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
