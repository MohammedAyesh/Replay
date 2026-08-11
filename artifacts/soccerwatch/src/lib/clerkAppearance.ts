const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export const clerkAppearance = {
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/replay-mark.svg`,
  },
  variables: {
    // Surfaces
    colorBackground: "#0B0F1A",
    colorInput: "rgba(255,255,255,.035)",
    colorInputForeground: "#F3F6FA",
    colorNeutral: "#141B2C",

    // Primary action — lime with dark text
    colorPrimary: "#D4FF4F",
    colorForeground: "#F3F6FA",
    colorMutedForeground: "rgba(243,246,250,.5)",

    // Functional
    colorDanger: "#FF5A3C",

    // Typography — Inter for Latin, Tajawal covers Arabic glyphs
    fontFamily: "'Inter', 'Tajawal', sans-serif",

    borderRadius: "13px",
  },
  elements: {
    // Modal shell
    rootBox: "w-full flex justify-center",
    cardBox:
      "!rounded-[26px] w-[440px] max-w-full overflow-hidden !border !border-white/[0.09] !bg-[#141B2C] !shadow-[0_30px_70px_rgba(0,0,0,.45)]",
    card: "!bg-transparent !shadow-none !border-0 !rounded-none" as string,
    footer: "!bg-[#141B2C] !shadow-none !border-0 !rounded-none" as string,

    // Modal surface — navy gradient (#141B2C)
    "cardBox > div": {
      background: "linear-gradient(160deg, rgba(255,255,255,.05), rgba(255,255,255,.015)), #141B2C",
      border: "1px solid rgba(255,255,255,.09)",
      borderRadius: "26px",
      boxShadow: "0 30px 70px rgba(0,0,0,.45)",
    } as object,

    // Header
    headerTitle: "font-bold",
    headerSubtitle: "",

    // Primary button — lime bg, dark text, fully rounded
    formButtonPrimary:
      "!bg-[#D4FF4F] hover:!bg-[#c8f240] !text-[#0B0F1A] font-semibold !rounded-[14px]",

    // Social / secondary buttons
    socialButtonsBlockButton:
      "!bg-white/[0.05] !border-white/[0.12] hover:!bg-white/[0.08] !text-[#F3F6FA] !rounded-[13px]",
    socialButtonsBlockButtonText: "font-medium",

    // Form fields
    formFieldLabel: "font-medium",
    formFieldInput:
      "!border-white/[0.1] focus:!border-[#D4FF4F] !bg-white/[0.035] !text-[#F3F6FA] !rounded-[13px]",

    // Footer & links
    footerAction: "!bg-transparent",
    footerActionText: "",
    footerActionLink: "!text-[#2FD8C4] font-semibold",

    // Dividers
    dividerText: "",
    dividerLine: "!bg-white/[0.1]",

    // Inline indicators
    identityPreviewEditButton: "!text-[#D4FF4F]",
    formFieldSuccessText: "!text-[#D4FF4F]",

    // Alerts / errors
    alert: "!bg-[#FF5A3C]/10 !border-[#FF5A3C]/40",
    alertText: "",

    // OTP inputs
    otpCodeFieldInput: "!border-white/[0.1] focus:!border-[#D4FF4F] !bg-white/[0.035] !text-[#F3F6FA] !rounded-[13px]",

    // Logo
    logoBox: "mb-2",
    logoImage: "h-10 w-10",

    formFieldRow: "",
    main: "",
  },
};
