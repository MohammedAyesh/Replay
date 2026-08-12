const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export const clerkAppearance = {
  cssLayerName: "clerk",
  layout: {
    unsafe_disableDevelopmentModeWarnings: true,
  },
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/replay-mark.svg`,
  },
  variables: {
    // Surfaces
    colorBackground: "#0B0F1A",
    colorInput: "#0B0F1A",
    colorInputForeground: "#F3F6FA",
    colorNeutral: "#232C42",

    // Primary action — lime with dark text
    colorPrimary: "#D4FF4F",
    colorForeground: "#F3F6FA",
    colorMutedForeground: "#8A93A6",

    // Functional
    colorDanger: "#FF5A3C",

    // Typography — Inter for Latin, Tajawal covers Arabic glyphs
    fontFamily: "'Inter', 'Tajawal', sans-serif",

    // Radii — inputs at 12px; buttons overridden via elements below
    borderRadius: "0.75rem",
  },
  elements: {
    // Modal shell
    rootBox: "w-full flex justify-center",
    cardBox: "!rounded-[26px] w-[440px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !rounded-none" as string,
    footer: "!shadow-none !border-0 !rounded-none" as string,

    // Modal surface — navy (#141B2C)
    "cardBox > div": {
      backgroundImage: "linear-gradient(160deg, rgba(255,255,255,.05), rgba(255,255,255,.015))",
      backgroundColor: "#141B2C",
      border: "1px solid rgba(255,255,255,.09)",
      boxShadow: "0 30px 70px rgba(0,0,0,.45)",
    } as object,

    // Header
    headerTitle: "font-bold",
    headerSubtitle: "",

    // Primary button — lime bg, dark text, fully rounded
    formButtonPrimary:
      "!bg-[#D4FF4F] hover:!bg-[#c8f240] !text-[#0B0F1A] font-semibold !rounded-[99px]",

    // Social / secondary buttons
    socialButtonsBlockButton: "!border-[#232C42] hover:!bg-[#1B2438]",
    socialButtonsBlockButtonText: "font-medium",

    // Form fields
    formFieldLabel: "font-medium",
    formFieldInput:
      "!border-[#232C42] focus:!border-[#D4FF4F] !bg-[#0B0F1A] !rounded-[12px]",

    // Footer & links
    footerAction: "!bg-transparent",
    footerActionText: "",
    footerActionLink: "!text-[#D4FF4F] font-semibold",

    // Dividers
    dividerText: "",
    dividerLine: "!bg-[#232C42]",

    // Inline indicators
    identityPreviewEditButton: "!text-[#D4FF4F]",
    formFieldSuccessText: "!text-[#D4FF4F]",

    // Alerts / errors
    alert: "!bg-[#FF5A3C]/10 !border-[#FF5A3C]/40",
    alertText: "",

    // OTP inputs
    otpCodeFieldInput: "!border-[#232C42] focus:!border-[#D4FF4F]",

    // Logo
    logoBox: "mb-2",
    logoImage: "h-12 w-12",

    formFieldRow: "",
    main: "",
  },
};
