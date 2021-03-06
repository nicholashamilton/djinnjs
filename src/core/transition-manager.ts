import { env, debug } from "./env";
import { defaultTransition } from "./config";

/** Import transitions */
import { fade } from "../transitions/fade";
import { slide } from "../transitions/slide";
import { none } from "../transitions/none";

/**
 * The transition manager is used to manager Pjax page transitions. There must always be a `default` page transition, even if it's `none`
 * The page transition is set using the `pjax-transition` attribute on the element that riggered the transition.
 * Page transition data is set using the `pjax-transition-data` attribute on the element that riggered the transition.
 * Page transition data is a `string` by default, typically it's a stringified JSON object.
 * DO NOT parse the JSON object until you need it. Passing structured data is slower and has a higher resource cost than strings.
 * @param selector - the query selector string that will be used to get the views that need to be swapped
 * @param newHTML - the incoming `innerHTML` for the new view
 * @param transition - the name of the desired transition
 * @param transitionData - a custom data object or value that can be used to modify the transition
 */
export function transitionManager(selector: string, newHTML: string, transition: string | null, transitionData: string | null): Promise<{}> {
    return new Promise(resolve => {
        /** Pjax doesn't load on 2g, however, network conditions can change. Do not touch. */
        if (env.connection === "2g" || env.connection === "slow-2g") {
            none(selector, newHTML, transitionData).then(() => {
                resolve();
            });
        } else {
            const transitionEffect = transition || defaultTransition;
            switch (transitionEffect) {
                case "slide":
                    slide(selector, newHTML, transitionData).then(() => {
                        resolve();
                    });
                    break;
                case "fade":
                    fade(selector, newHTML, transitionData).then(() => {
                        resolve();
                    });
                    break;
                case "none":
                    none(selector, newHTML, transitionData).then(() => {
                        resolve();
                    });
                    break;
                default:
                    if (debug) {
                        console.error(`Undefined transition handle: ${transition}`);
                    }
                    none(selector, newHTML, transitionData).then(() => {
                        resolve();
                    });
                    break;
            }
        }
    });
}
