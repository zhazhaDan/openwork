/** @jsxImportSource react */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, Globe, Loader2, Plus, RotateCw, X } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import { isElectronRuntime } from "../../../../app/utils";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getActiveTab,
  type BrowserStatePayload,
  type BrowserTabInfo,
  useBrowserState,
} from "./use-browser-state";

type BrowserPanelProps = { onClose: () => void };

function getTabLabel(tab: BrowserTabInfo) {
  if (tab.title) {
    return tab.title;
  }

  if (tab.url && tab.url !== "about:blank") {
    return tab.url;
  }

  return "New tab";
}

function getNativeMenuPoint(
  el: HTMLElement | null,
  point?: { clientX: number; clientY: number },
) {
  const zoom = window.__OPENWORK_ZOOM_FACTOR__ ?? 1;

  if (point) {
    return {
      x: Math.round(point.clientX * zoom),
      y: Math.round(point.clientY * zoom),
    };
  }

  if (!el) {
    return undefined;
  }

  const rect = el.getBoundingClientRect();

  return {
    x: Math.round((rect.left + 8) * zoom),
    y: Math.round((rect.bottom + 4) * zoom),
  };
}

function getElectronBrowser() {
  if (!isElectronRuntime()) {
    return null;
  }

  return window.__OPENWORK_ELECTRON__?.browser ?? null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    getElectronBrowser()?.hide?.();
  });
}

function computeBounds(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const zoom = window.__OPENWORK_ZOOM_FACTOR__ ?? 1;

  // WebContentsView bounds use the BrowserWindow contentView coordinate space.
  // Renderer client rects are reported in zoomed CSS pixels, so convert back to
  // contentView coordinates by applying the desktop zoom factor. Dividing by the
  // zoom factor shifts the native browser into the transcript.
  return {
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.round(rect.width * zoom),
    height: Math.round(rect.height * zoom),
  };
}

function sameBounds(
  left: { x: number; y: number; width: number; height: number } | null,
  right: { x: number; y: number; width: number; height: number },
) {
  return Boolean(
    left &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height,
  );
}

type BrowserTabProps = {
  tab: BrowserTabInfo;
};

function BrowserTab({ tab }: BrowserTabProps) {
  const dragControls = useDragControls();
  const tabRef = useRef<HTMLDivElement>(null);
  const label = getTabLabel(tab);

  const selectTab = () => {
    getElectronBrowser()?.selectTab?.(tab.tabId);
  };

  const closeTab = () => {
    getElectronBrowser()?.closeTab?.(tab.tabId);
  };

  const showTabContextMenu = (point?: { clientX: number; clientY: number }) => {
    void getElectronBrowser()?.showTabContextMenu?.(
      tab.tabId,
      getNativeMenuPoint(tabRef.current, point),
    );
  };

  return (
    <Reorder.Item
      as="div"
      value={tab.tabId}
      id={tab.tabId}
      layout="position"
      dragElastic={0}
      dragListener={false}
      dragControls={dragControls}
      className="group relative w-44 min-w-0 shrink-0"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        showTabContextMenu({ clientX: event.clientX, clientY: event.clientY });
      }}
    >
      <div ref={tabRef} className="relative">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "w-full min-w-0 justify-start gap-2 px-2 pr-8 text-left text-sm font-normal text-muted-foreground hover:bg-muted hover:text-foreground",
            tab.isActive && "bg-muted/80 text-foreground",
          )}
          onClick={selectTab}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }

            dragControls.start(event);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
              return;
            }

            event.preventDefault();
            showTabContextMenu();
          }}
          title={label}
          aria-label={`Select tab: ${label}`}
        >
          {tab.favicon ? (
            <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" />
          ) : tab.isLoading ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Globe />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100",
            tab.isActive && "text-foreground hover:bg-muted hover:text-foreground",
          )}
          title="Close tab"
          aria-label={`Close tab: ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            closeTab();
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          <X />
        </Button>
      </div>
    </Reorder.Item>
  );
}

export function BrowserPanel({ onClose }: BrowserPanelProps) {
  const [state, dispatch] = useBrowserState();
  const urlFocusedRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const shownRef = useRef(false);
  const boundsFrameRef = useRef<number | null>(null);
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // Subscribe to state changes from the main process
  useEffect(() => {
    const browser = getElectronBrowser();

    if (!browser) {
      return;
    }

    const unsub = browser.onStateChange?.((s: BrowserStatePayload) => {
      dispatch({
        type: "browserStateChanged",
        browserState: s,
        syncUrlInput: !urlFocusedRef.current,
      });
    });

    browser.getState?.().then((s: BrowserStatePayload | null) => {
      if (s) {
        dispatch({
          type: "browserStateChanged",
          browserState: s,
          syncUrlInput: true,
        });
      }
    });

    return unsub;
  }, []);

  // Correct stale native bounds after every render/Fast Refresh pass. The
  // WebContentsView is owned by Electron main process, so it can keep painting
  // at old coordinates even when React has re-rendered the pane.
  useLayoutEffect(() => {
    const browser = getElectronBrowser();
    const content = contentRef.current;
    if (!browser || !content) return;
    const bounds = computeBounds(content);
    if (bounds.width < 1 || bounds.height < 1) return;
    browser.setBounds?.(bounds);
    lastBoundsRef.current = bounds;
  });

  // Show the browser view when the panel mounts, keep bounds in sync, hide on unmount.
  useLayoutEffect(() => {
    const browser = getElectronBrowser();

    if (!browser || !contentRef.current) {
      return;
    }

    const content = contentRef.current;
    let disposed = false;

    const resetNativeView = async () => {
      await browser.hide?.();
      if (disposed) return;
      shownRef.current = false;
      lastBoundsRef.current = null;
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    const syncBounds = () => {
      const bounds = computeBounds(content);

      if (bounds.width < 1 || bounds.height < 1) {
        if (shownRef.current) {
          browser.hide?.();
          shownRef.current = false;
          lastBoundsRef.current = null;
        }
        return;
      }

      if (!shownRef.current) {
        browser.show?.(bounds);
        shownRef.current = true;
        lastBoundsRef.current = bounds;
        return;
      }

      if (!sameBounds(lastBoundsRef.current, bounds)) {
        browser.setBounds?.(bounds);
        lastBoundsRef.current = bounds;
      }
    };

    const watchBounds = () => {
      syncBounds();
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    void resetNativeView();

    const observer = new ResizeObserver(scheduleSyncBounds);

    function scheduleSyncBounds() {
      syncBounds();
    }

    observer.observe(content);

    window.addEventListener("resize", scheduleSyncBounds);
    window.addEventListener("scroll", scheduleSyncBounds, true);

    return () => {
      disposed = true;
      observer.disconnect();

      window.removeEventListener("resize", scheduleSyncBounds);
      window.removeEventListener("scroll", scheduleSyncBounds, true);

      if (boundsFrameRef.current != null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }

      browser.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;
    };
  }, []);

  const navigate = useCallback((url?: string) => {
    getElectronBrowser()?.navigate?.(url ?? state.urlInput);
  }, [state.urlInput]);

  const createTab = useCallback(() => {
    getElectronBrowser()?.createTab?.();
  }, []);

  const reorderTabs = useCallback((tabIds: string[]) => {
    dispatch({ type: "tabsReordered", tabIds });
    getElectronBrowser()?.reorderTabs?.(tabIds);
  }, []);

  const back = useCallback(() => {
    getElectronBrowser()?.back?.();
  }, []);

  const forward = useCallback(() => {
    getElectronBrowser()?.forward?.();
  }, []);

  const reload = useCallback(() => {
    getElectronBrowser()?.reload?.();
  }, []);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      navigate();
      urlInputRef.current?.blur();
    }
  }, [navigate]);

  const activeTab = getActiveTab(state);
  const browser = getElectronBrowser();

  if (!isElectronRuntime() || !browser) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground">
        <p className="text-sm">Browser panel is only available in the desktop app.</p>
      </div>
    );
  }

  return (
    <TooltipProvider delay={1000}>
      <div className="flex h-full flex-col">
        <div className="shrink-0 border-b border-border bg-background mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
          <div className="flex h-10 items-center gap-1 border-b border-border/60 px-2">
            <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
              <Reorder.Group
                as="div"
                axis="x"
                values={state.tabs.map((tab) => tab.tabId)}
                onReorder={reorderTabs}
                className="flex min-w-max items-center gap-1"
              >
                {state.tabs.map((tab) => (
                  <BrowserTab
                    key={tab.tabId}
                    tab={tab}
                  />
                ))}
              </Reorder.Group>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={createTab} aria-label="New tab">
                    <Plus />
                  </Button>
                )}
              />
              <TooltipContent>New tab</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex h-10 items-center gap-1 px-2">
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={back} disabled={!activeTab.canGoBack} aria-label="Go back">
                    <ArrowLeft />
                  </Button>
                )}
              />
              <TooltipContent>Back</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={forward} disabled={!activeTab.canGoForward} aria-label="Go forward">
                    <ArrowRight />
                  </Button>
                )}
              />
              <TooltipContent>Forward</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={reload} aria-label="Reload page">
                    {activeTab.isLoading ? <Loader2 className="animate-spin" /> : <RotateCw />}
                  </Button>
                )}
              />
              <TooltipContent>Reload</TooltipContent>
            </Tooltip>
            <InputGroup className="mx-1 h-7 flex-1 rounded-md">
              <InputGroupInput
                ref={urlInputRef}
                type="text"
                className="h-7"
                value={state.urlInput}
                onChange={(e) =>
                  dispatch({ type: "urlInputChanged", value: e.target.value })
                }
                onKeyDown={handleUrlKeyDown}
                onFocus={() => { urlFocusedRef.current = true; urlInputRef.current?.select(); }}
                onBlur={() => { urlFocusedRef.current = false; }}
                placeholder="Enter URL..."
                spellCheck={false}
                autoComplete="off"
              />
              <InputGroupAddon align="inline-start" className="ps-2">
                <Globe />
              </InputGroupAddon>
            </InputGroup>
            <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close browser" aria-label="Close browser panel">
              <X />
            </Button>
          </div>
        </div>
        {/* WebContentsView renders in this area (managed by Electron main process) */}
        <div ref={contentRef} className="min-h-0 flex-1 overflow-hidden" />
      </div>
    </TooltipProvider>
  );
}
