import baseConfig from "../shared/tailwind.config.js";

/** @type {import('tailwindcss').Config} */
export default {
  ...baseConfig,
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
};
