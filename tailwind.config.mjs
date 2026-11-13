/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 特斯拉式：纯黑白 + 中性灰阶
        ink: "#0a0a0a",
        paper: "#ffffff",
        graphite: "#5f5f5f",
        mist: "#f6f6f6",
        hairline: "#e4e4e4",
        stone: {
          50: "#fafafa",
          100: "#f5f5f5",
          200: "#e8e8e8",
          300: "#d4d4d4",
          400: "#a1a1a1",
          500: "#767676",
          600: "#525252",
          700: "#333333",
          800: "#1a1a1a",
          900: "#0a0a0a",
        },
      },
      borderRadius: {
        none: "0px",
        sm: "0px",
        DEFAULT: "0px",
        md: "0px",
        lg: "0px",
        xl: "0px",
        "2xl": "0px",
        "3xl": "0px",
      },
      fontFamily: {
        sans: [
          "Helvetica Neue",
          "-apple-system",
          "BlinkMacSystemFont",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "sans-serif",
        ],
      },
      letterSpacing: {
        label: "0.18em",
        wide: "0.06em",
      },
      maxWidth: {
        content: "46rem",
      },
    },
  },
  plugins: [],
};
