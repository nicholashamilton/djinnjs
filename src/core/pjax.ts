import { broadcaster } from "./broadcaster";
import { debug, env, uuid } from "./env";
import { sendPageView, setupGoogleAnalytics } from "./gtags.js";
import { transitionManager } from "./transition-manager";
import { djinnjsOutDir, gaId, disablePrefetching, disableServiceWorker } from "./config";
import { notify } from "../web_modules/@codewithkyle/notifications";
import { fetchCSS } from "./fetch";

interface PjaxState {
    activeRequestUid: string;
}

interface NavigaitonRequest {
    body?: string;
    title?: string;
    url: string;
    history: "push" | "replace";
    requestUid: string;
    transition: string | null;
    transitionData: string | null;
    targetSelector: string;
}

class Pjax {
    private state: PjaxState;
    private worker: Worker;
    private serviceWorker: ServiceWorker;
    private navigationRequestQueue: Array<NavigaitonRequest>;
    private io: IntersectionObserver;

    constructor() {
        this.state = {
            activeRequestUid: null,
        };
        this.worker = null;
        this.serviceWorker = null;
        this.navigationRequestQueue = [];
        this.io = new IntersectionObserver(this.handleIntersection);
        this.init();
    }

    /**
     * Initializes the Pjax class.
     */
    private init(): void {
        /** Prepare our reload prompt tracking for the session */
        if (!sessionStorage.getItem("prompts")) {
            sessionStorage.setItem("prompts", "0");
        }

        if (!localStorage.getItem("contentCache")) {
            localStorage.setItem("contentCache", `${Date.now()}`);
        }

        /** Hookup Pjax's inbox */
        broadcaster.hookup("pjax", this.inbox.bind(this));

        /** Prepare Google Analytics */
        setupGoogleAnalytics(gaId);

        /** Prepare the Pjax Web Worker */
        this.worker = new Worker(`${window.location.origin}/${djinnjsOutDir}/pjax-worker.js`);
        this.worker.onmessage = this.handleWorkerMessage.bind(this);

        /** Attempt to register a service worker */
        if ("serviceWorker" in navigator && !disableServiceWorker) {
            navigator.serviceWorker
                .register(`${window.location.origin}/service-worker.js`, { scope: "/" })
                .then(() => {
                    /** Verify the service worker was registered correctly */
                    if (navigator.serviceWorker.controller) {
                        this.serviceWorker = navigator.serviceWorker.controller;
                        navigator.serviceWorker.onmessage = this.handleServiceWorkerMessage.bind(this);

                        /** Tell the service worker to get the latest cachebust data */
                        this.serviceWorker.postMessage({
                            type: "cachebust",
                            url: window.location.href,
                        });

                        /** Tell Pjax to check if the current page is stale */
                        broadcaster.message("pjax", { type: "revision-check" });
                    }
                })
                .catch(error => {
                    if (debug) {
                        console.error("Registration failed with " + error);
                    }
                });
        }
        /** Add event listeners */
        window.addEventListener("popstate", this.windowPopstateEvent);
        /** Update the history state with the required `state.url` value */
        window.history.replaceState({ url: window.location.href }, document.title, window.location.href);
        fetchCSS("pjax-notification");
    }

    /**
     * The public inbox for the Pjax class. All incoming messages sent through the `Broadcaster` will be received here.
     * @param data - the `MessageData` passed into the inbox by the `Broadcaster` class
     */
    private inbox(data: MessageData): void {
        const { type } = data;
        switch (type) {
            case "revision-check":
                this.checkPageRevision();
                break;
            case "hijack-links":
                this.collectLinks();
                break;
            case "load":
                this.navigate(data.url, data?.transition, data?.transitionData, data?.history, data?.target);
                break;
            case "finalize-pjax":
                this.updateHistory(data.title, data.url, data.history);
                if (new RegExp("#").test(data.url)) {
                    this.scrollToAnchor(data.url);
                }
                this.collectLinks();
                this.checkPageRevision();
                sendPageView(window.location.pathname, gaId);
                if (!disablePrefetching) {
                    this.prefetchLinks();
                }
                broadcaster.message("pjax", {
                    type: "completed",
                });
                break;
            case "css-ready":
                this.swapPjaxContent(data.requestUid);
                break;
            case "prefetch":
                if (!disablePrefetching) {
                    this.prefetchLinks();
                }
                break;
            case "init":
                /** Tell Pjax to hijack all viable links */
                broadcaster.message("pjax", { type: "hijack-links" });
                /** Tell Pjax to prefetch links */
                broadcaster.message("pjax", {
                    type: "prefetch",
                });
                break;
            default:
                return;
        }
    }

    /**
     * Handles messages from the Service Worker.
     * @param e - the `MessageEvent` object
     */
    private handleServiceWorkerMessage(e: MessageEvent): void {
        const { type } = e.data;
        switch (type) {
            case "page-refresh":
                let promptCount = parseInt(sessionStorage.getItem("prompts"));
                promptCount = promptCount + 1;
                sessionStorage.setItem("prompts", `${promptCount}`);
                notify({
                    message: "A new version of this page is available.",
                    closeable: true,
                    force: true,
                    duration: Infinity,
                    buttons: [
                        {
                            label: "Reload",
                            callback: () => {
                                window.location.reload();
                            },
                        },
                    ],
                });
                break;
            case "cachebust":
                sessionStorage.setItem("maxPrompts", `${e.data.max}`);
                const currentPromptCount = sessionStorage.getItem("prompts");
                if (parseInt(currentPromptCount) >= e.data.max) {
                    sessionStorage.setItem("prompts", "0");
                    this.serviceWorker.postMessage({
                        type: "clear-content-cache",
                    });
                }
                const contentCacheTimestap = parseInt(localStorage.getItem("contentCache"));
                const difference = Date.now() - contentCacheTimestap;
                const neededDifference = e.data.contentCacheExpires * 24 * 60 * 60 * 1000;
                if (difference >= neededDifference) {
                    localStorage.setItem("contentCache", `${Date.now()}`);
                    this.serviceWorker.postMessage({
                        type: "clear-content-cache",
                    });
                }
                break;
            default:
                if (debug) {
                    console.error(`Undefined Service Worker response message type: ${type}`);
                }
                break;
        }
    }

    /**
     * Handles messages from the Pjax Web Worker.
     * @param e - the `MessageEvent` object
     */
    private handleWorkerMessage(e: MessageEvent): void {
        const { type } = e.data;
        switch (type) {
            case "revision-check":
                if (e.data.status === "stale") {
                    this.serviceWorker.postMessage({
                        type: "page-refresh",
                        url: e.data.url,
                        network: env.connection,
                    });
                }
                break;
            case "pjax":
                this.handlePjaxResponse(e.data.requestId, e.data.status, e.data.url, e.data?.body, e.data?.error);
                break;
            default:
                if (debug) {
                    console.error(`Undefined Pjax Worker response message type: ${type}`);
                }
                break;
        }
    }

    private scrollToAnchor(url: string): void {
        const anchor = document.body.querySelector(`a[name="${url.match(/\#.*/g)[0].replace("#", "")}"]`);
        if (anchor) {
            anchor.scrollIntoView();
        }
    }

    /**
     * Creates and sends a navigation request to the Pjax web worker and queues navigation request.
     * @param url - the URL of the requested page
     * @param transition - the name of the desired transition effect
     * @param transitionData - optional data that could modify the transition
     * @param history - how Pjax should handle the windows history manipulation
     * @param targetEl - the `pjax-id` attribute value
     */
    private navigate(url: string, transition: string = null, transitionData: string = null, history: "push" | "replace" = "push", targetEl: string = null): void {
        env.startPageTransition();
        const requestUid = uuid();
        this.state.activeRequestUid = requestUid;
        const navigationRequest: NavigaitonRequest = {
            url: url,
            history: history,
            requestUid: requestUid,
            transition: transition,
            transitionData: transitionData,
            targetSelector: targetEl,
        };
        this.navigationRequestQueue.push(navigationRequest);
        this.worker.postMessage({
            type: "pjax",
            requestId: requestUid,
            url: url,
            currentUrl: location.href,
        });
    }

    /**
     * Handles the windows `popstate` event.
     * @param e - the `PopStateEvent` object
     */
    private hijackPopstate(e: PopStateEvent): void {
        /** Only hijack the event when the `history.state` object contains a URL */
        if (e.state?.url) {
            /** Tells the Pjax class to load the URL stored in this windows history.
             * In order to preserve the timeline navigation the history will use `replace` instead of `push`.
             */
            broadcaster.message("pjax", {
                type: "load",
                url: e.state.url,
                history: "replace",
            });
        }
    }
    private windowPopstateEvent: EventListener = this.hijackPopstate.bind(this);

    /**
     * Handles history manipulation by replacing or pushing the new state into the windows history timeline.
     * @param title - the new document title
     * @param url - the new pages URL
     * @param history - how the window history should be manipulated
     */
    private updateHistory(title: string, url: string, history: "push" | "replace"): void {
        if (history === "replace") {
            window.history.replaceState(
                {
                    url: url,
                },
                title,
                url
            );
        } else {
            window.history.pushState(
                {
                    url: url,
                },
                title,
                url
            );
        }
    }

    /**
     * Called when the `click` event fires on a Pjax tracked anchor element.
     * @param e - click `Event`
     */
    private hijackRequest(e: Event): void {
        e.preventDefault();
        const target = e.currentTarget as HTMLAnchorElement;
        /** Tell Pjax to load the clicked elements page */
        broadcaster.message("pjax", {
            type: "load",
            url: target.href,
            transition: target.getAttribute("pjax-transition"),
            transitionData: target.getAttribute("pjax-transition-data"),
            target: target.getAttribute("pjax-view-id"),
        });
    }
    private handleLinkClick: EventListener = this.hijackRequest.bind(this);

    /**
     * Collect all anchor elements with a `href` attribute and add a click event listener.
     * Ignored links are:
     * - any link with a `no-pjax` attribute
     * - any link with a `no-pjax` class
     * - any link with a `target` attribute
     */
    private collectLinks(): void {
        const unregisteredLinks = Array.from(document.body.querySelectorAll("a[href]:not([pjax-tracked]):not([no-pjax]):not([target]):not(.no-pjax)"));
        if (unregisteredLinks.length) {
            unregisteredLinks.map((link: HTMLAnchorElement) => {
                link.setAttribute("pjax-tracked", "true");
                link.addEventListener("click", this.handleLinkClick);
            });
        }
    }

    /**
     * Handles the Pjax response from the web worker.
     * This method will update the `NavigationRequest` object and continue with the transition or will remove the stale request or will fallback to traditional (native) page navigaiton when an error occurs.
     * @param requestId - the navigation request's unique ID
     * @param status - the response status of the request
     * @param url - the requested URL
     * @param body - the body text of the requested page
     * @param error - the error message of the failed request
     */
    private handlePjaxResponse(requestId: string, status: string, url: string, body?: string, error?: string) {
        const request = this.getNavigaitonRequest(requestId);
        if (requestId === this.state.activeRequestUid) {
            if (status === "external") {
                window.location.href = url;
            } else if (status === "hash-change") {
                location.hash = url.match(/\#.*/g)[0].replace("#", "");
            } else if (status === "ok") {
                const tempDocument: HTMLDocument = document.implementation.createHTMLDocument("pjax-temp-document");
                tempDocument.documentElement.innerHTML = body;

                let selector;
                let currentMain;
                if (request.targetSelector !== null) {
                    selector = `[pjax-id="${request.targetSelector}"]`;
                    currentMain = document.body.querySelector(selector);
                } else {
                    selector = "main";
                    currentMain = document.body.querySelector(selector);
                    const mainId = currentMain.getAttribute("pjax-id");
                    if (mainId) {
                        selector = `[pjax-id="${mainId}"]`;
                    }
                }

                const incomingMain = tempDocument.querySelector(selector);

                if (incomingMain && currentMain) {
                    /** Tells the runtime class to parse the incoming HTML for any new CSS files */
                    broadcaster.message("runtime", {
                        type: "parse",
                        body: incomingMain.innerHTML,
                        requestUid: requestId,
                    });
                    request.body = incomingMain.innerHTML;
                    request.title = tempDocument.title;
                } else {
                    console.error("Failed to find matching elements.");
                    window.location.href = url;
                }
            } else {
                console.error(`Failed to fetch page: ${url}. Server responded with: ${error}`);
                window.location.href = url;
            }
        } else {
            this.removeNavigationRequest(request.requestUid);
            if (status !== "ok") {
                console.error(`Failed to fetch page: ${url}. Server responded with: ${error}`);
            }
        }
    }

    /**
     * Swaps the main elements inner HTML.
     * @param requestUid - the navigation request unique id
     */
    private swapPjaxContent(requestUid: string) {
        const request = this.getNavigaitonRequest(requestUid);
        if (request.requestUid === this.state.activeRequestUid) {
            env.endPageTransition();

            let selector;
            if (request.targetSelector !== null) {
                selector = `[pjax-id="${request.targetSelector}"]`;
            } else {
                selector = "main";
            }

            transitionManager(selector, request.body, request.transition, request.transitionData).then(() => {
                document.title = request.title;
                broadcaster.message("pjax", {
                    type: "finalize-pjax",
                    url: request.url,
                    title: request.title,
                    history: request.history,
                });
                broadcaster.message("runtime", {
                    type: "mount-components",
                });
                broadcaster.message("runtime", {
                    type: "mount-inline-scripts",
                    selector: selector,
                });
            });
        }
        this.removeNavigationRequest(request.requestUid);
    }

    /**
     * Removes the `NavigationRequest` object from the queue.
     * @param requestId - the unique ID of the `NavigationRequest` object
     */
    private removeNavigationRequest(requestId: string): void {
        for (let i = 0; i < this.navigationRequestQueue.length; i++) {
            if (this.navigationRequestQueue[i].requestUid === requestId) {
                this.navigationRequestQueue.splice(i, 1);
                break;
            }
        }
    }

    /**
     * Gets the `NavigationRequest` object from the queue.
     * @param requestId - the unique ID of the `NavigationRequest` object
     */
    private getNavigaitonRequest(requestId: string): NavigaitonRequest {
        for (let i = 0; i < this.navigationRequestQueue.length; i++) {
            if (this.navigationRequestQueue[i].requestUid === requestId) {
                return this.navigationRequestQueue[i];
            }
        }

        return null;
    }

    /**
     * Sends a `revision-check` message to the Pjax web worker.
     */
    private checkPageRevision(): void {
        this.worker.postMessage({
            type: "revision-check",
            url: window.location.href,
        });
    }

    /** Collect primary navigation links and tell the Pjax web worker to prefetch the pages. */
    private prefetchLinks(): void {
        /** Require a service worker & at least a 3g connection & respect the users data saver setting */
        if (env.connection === "2g" || env.connection === "slow-2g" || !("serviceWorker" in navigator) || env.dataSaver) {
            return;
        }
        const urls: Array<string> = [];

        /** Header links */
        const headerLinks = Array.from(document.body.querySelectorAll("header a[href]:not([target]):not([pjax-prefetched]):not(prevent-pjax):not(no-transition)"));
        headerLinks.map((link: HTMLAnchorElement) => {
            link.setAttribute("pjax-prefetched", "true");
            urls.push(link.href);
        });

        /** All other navigation links */
        const navLinks = Array.from(document.body.querySelectorAll("nav a[href]:not([target]):not([pjax-prefetched]):not(prevent-pjax):not(no-transition)"));
        navLinks.map((link: HTMLAnchorElement) => {
            link.setAttribute("pjax-prefetched", "true");
            urls.push(link.href);
        });

        /** Send the requested URLs to the Pjax web worker */
        this.worker.postMessage({
            type: "prefetch",
            urls: urls,
        });

        /** Require at least a 4g connection while respecting the users data  */
        if (env.connection === "3g") {
            return;
        }

        const allLinks = Array.from(document.body.querySelectorAll("a[href]:not([target]):not([pjax-prefetched]):not(prevent-pjax):not(no-transition)"));
        allLinks.map((link: HTMLAnchorElement) => {
            link.setAttribute("pjax-prefetched", "true");
            this.io.observe(link);
        });
    }

    /**
     * Grabs the URLs from all of the observed anchor elements, unobserves the element, and sends the URLs to the Pjax web worker.
     * @param links - array of `IntersectionObserverEntry` objects
     */
    private prefetchLink(links: Array<IntersectionObserverEntry>): void {
        const urls: Array<string> = [];
        links.map(entry => {
            if (entry.isIntersecting) {
                const link = entry.target as HTMLAnchorElement;
                this.io.unobserve(link);
                urls.push(link.href);
            }
        });
        if (urls.length) {
            /** Send the requested URLs to the Pjax web worker */
            this.worker.postMessage({
                type: "prefetch",
                urls: urls,
            });
        }
    }
    private handleIntersection: IntersectionObserverCallback = this.prefetchLink.bind(this);
}
new Pjax();
