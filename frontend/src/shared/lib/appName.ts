// The product name, for code the web app and the Word add-in share (such as
// userError.ts). Framework-free: each build substitutes its own variable at
// build time, Next.js NEXT_PUBLIC_APP_NAME and the add-in's webpack
// REACT_APP_APP_NAME, and the add-in defines NEXT_PUBLIC_APP_NAME as empty so
// both expressions compile there. Unset or blank keeps Mike's name.

const configuredName = (
    process.env.NEXT_PUBLIC_APP_NAME ||
    process.env.REACT_APP_APP_NAME ||
    ""
).trim();

/** The product name shown in the interface. */
export const APP_NAME = configuredName ? configuredName : "Mike";
