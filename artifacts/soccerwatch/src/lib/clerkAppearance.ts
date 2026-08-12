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
    colorInput: "rgba(255,255,255,.035)",
    colorInputForeground: "#F3F6FA",
    colorNeutral: "#232C42",

    // Primary action — lime with dark text
    colorPrimary: "#D4FF4F",
    colorForeground: "#F3F6FA",
    colorMutedForeground: "#8A93A6",

    // Functional
    colorDanger: "#FF5A3C",

    // Typography — Arabic-first auth card with Latin fallback
    fontFamily: "'Tajawal', 'Cairo', 'Inter', sans-serif",

    // Reference card uses a soft, rounded 26px system
    borderRadius: "0.8125rem",
  },
  elements: {
    // Modal shell
    rootBox: "!w-[calc(100%+48px)] !-mx-6 flex justify-center",
    cardBox:
      "!rounded-[26px] !w-full !max-w-[440px] !overflow-hidden !border !border-white/[0.09] !bg-[#141B2C] !shadow-[0_30px_70px_rgba(0,0,0,0.45)]",
    card:
      "!shadow-none !border-0 !rounded-none !bg-transparent !px-6 !pt-[30px] !pb-[26px]" as string,
    footer:
      "!shadow-none !border-0 !rounded-none !bg-transparent !px-6 !pb-[26px]" as string,

    // Header
    headerTitle: "!font-['Cairo'] !font-extrabold !text-[19px] !leading-[1.35]",
    headerSubtitle:
      "!mt-2 !text-[13px] !font-semibold !leading-[1.4] !text-white/[0.55]",

    // Primary button — lime reference CTA with dark text
    formButtonPrimary:
      "!mt-[22px] !bg-[#D4FF4F] hover:!bg-[#c8f240] !text-[#0B0F1A] !font-extrabold !rounded-[14px] !py-4",

    // Social / secondary buttons — outlined translucent control
    socialButtonsBlockButton:
      "!border-white/[0.12] !bg-white/[0.05] hover:!bg-white/[0.09] !rounded-[14px] !py-[14px]",
    socialButtonsBlockButtonText:
      "!text-[#F3F6FA] !text-[13.5px] !font-bold",

    // Form fields — lighter fill and stronger Arabic labels
    formFieldLabel:
      "!font-['Tajawal'] !text-white/[0.7] !text-[12.5px] !font-bold",
    formFieldInput:
      "!border-white/[0.1] focus:!border-[#2FD8C4] !bg-white/[0.035] !rounded-[13px] !px-4 !py-[14px] !text-[13.5px] !font-medium",
    formFieldInputShowPasswordButton:
      "!text-white/[0.5] hover:!text-white/[0.8]",
    formFieldAction: "!text-[#2FD8C4] !text-[12px] !font-bold",

    // Footer & links — preserve the existing sign-in/sign-up actions
    footerAction:
      "!bg-[#141B2C] !shadow-none !border-0 !px-6 !pb-[26px]",
    footerActionText: "!mt-[18px] !text-white/[0.5] !text-[12.5px] !font-semibold",
    footerActionLink: "!text-[#D4FF4F] !font-extrabold",

    // Dividers — visible, but quiet
    dividerText: "!text-white/[0.4] !text-[11.5px] !font-semibold",
    dividerLine: "!bg-white/[0.1]",

    // Inline indicators
    identityPreviewEditButton: "!text-[#D4FF4F]",
    formFieldSuccessText: "!text-[#D4FF4F]",

    // Alerts / errors
    alert: "!bg-[#FF5A3C]/10 !border-[#FF5A3C]/40",
    alertText: "",

    // OTP inputs
    otpCodeFieldInput: "!border-[#232C42] focus:!border-[#D4FF4F]",

    // Clerk uses this element on development instances. Keep it out of the
    // card without affecting the surrounding auth shell.
    developmentModeBadge: "!hidden",
    developmentModeWarning: "!hidden",

    // Logo
    logoBox: "!mb-2",
    logoImage: "h-12 w-12",

    formFieldRow: "",
    main: "",
  },
};
