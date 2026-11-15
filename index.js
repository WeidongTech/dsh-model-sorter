/**
 * dsh-model-sorter — host half.
 *
 * The feature is entirely browser-side: the client half takes over
 * `conversation.input.model` and renders the sorted/letter-indexed picker
 * instead of the shipped one. This host module exists only so the package has
 * a mountable row in the profile's cordis tree — it registers no provider, no
 * adapter and no route.
 */

/** Host plugin body — contributes nothing host-side. */
export function apply() {}

export default { apply }
