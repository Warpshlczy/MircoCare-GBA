import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        aura: {
          bg: "#FFF7EC",
          warm: "#F4A259",
          deep: "#7A4A2B",
          accent: "#2E7D6B",
          danger: "#C0392B",
        },
      },
      fontSize: {
        // elderly-first defaults; body copy starts at 24px
        base: ["1.5rem", { lineHeight: "2.1rem" }],
      },
    },
  },
  plugins: [plugin(({ addVariant }) => addVariant("hc", ".hc &"))],
};

export default config;