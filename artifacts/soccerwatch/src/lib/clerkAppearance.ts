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
    colorInput: "#1B2338",
    colorInputForeground: "#F2F4F8",
    colorNeutral: "#232C42",

    // Primary action — lime with dark text
    colorPrimary: "#D4FF4F",
    colorForeground: "#F2F4F8",
    colorMutedForeground: "#8A93A6",

    // Functional
    colorDanger: "#8A93A6",

    // Typography — Arabic-first auth card with Latin fallback
    fontFamily: "'Inter', 'Tajawal', sans-serif",

    // Reference card uses a soft, rounded 26px system
    borderRadius: "0.8125rem",
  },
  elements: {
    // Modal shell
    rootBox: "w-full flex justify-center",
    cardBox:
      "!rounded-2xl !w-[400px] !max-w-full !mx-auto !overflow-hidden !border !border-[#232C42] !bg-[#141B2C] !shadow-none",
    card:
      "!shadow-none !border-0 !rounded-none !bg-transparent !px-6 !pt-[30px] !pb-[26px]" as string,
    footer:
      "!shadow-none !border-0 !rounded-none !bg-[#141B2C] !px-6 !pb-[26px]" as string,

    // Header
    headerTitle: "!font-['Inter'] !font-semibold !text-[19px] !leading-[1.35]",
    headerSubtitle:
      "!mt-2 !text-[13px] !font-medium !leading-[1.4] !text-[#8A93A6]",

    // Primary button — lime reference CTA with dark text
    formButtonPrimary:
      "!mt-[22px] !bg-[#D4FF4F] hover:!bg-[#D4FF4F] !text-[#0B0F1A] !font-semibold !rounded-full !py-4",

    // Social / secondary buttons — outlined translucent control
    socialButtonsBlockButton:
      "!border-[#7B5CFF] !bg-transparent hover:!bg-[#7B5CFF]/10 !rounded-full !py-[14px]",
    socialButtonsBlockButtonText:
      "!text-[#F2F4F8] !text-[13.5px] !font-semibold",

    // Form fields — lighter fill and stronger Arabic labels
    formFieldLabel:
      "!font-['Inter'] !text-[#8A93A6] !text-[12.5px] !font-semibold",
    formFieldInput:
      "!border-[#232C42] focus:!border-[#2FD8C4] !bg-[#1B2338] !rounded-xl !px-4 !py-[14px] !text-[13.5px] !font-medium",
    formFieldInputShowPasswordButton:
      "!text-[#8A93A6] hover:!text-[#F2F4F8]",
    formFieldAction: "!text-[#2FD8C4] !text-[12px] !font-bold",

    // Footer & links — preserve the existing sign-in/sign-up actions
    footerAction:
      "!flex !flex-row !items-center !justify-center !gap-1 !whitespace-nowrap !bg-[#141B2C] !shadow-none !border-0 !px-0 !pb-0",
    footerActionText:
      "!mt-0 !whitespace-nowrap !text-[#8A93A6] !text-[12.5px] !font-semibold",
    footerActionLink:
      "!whitespace-nowrap !text-[#D4FF4F] !font-extrabold",

    // Dividers — visible, but quiet
    dividerText: "!text-[#8A93A6] !text-[11.5px] !font-semibold",
    dividerLine: "!bg-[#232C42]",

    // Inline indicators
    identityPreviewEditButton: "!text-[#D4FF4F]",
    formFieldSuccessText: "!text-[#D4FF4F]",

    // Alerts / errors
    alert: "!bg-[#1B2338] !border-[#232C42]",
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
