/** Loads Meta's JavaScript SDK once and runs Facebook Login for Business with a configuration. */
type FBLoginResponse = {
  authResponse?: { code?: string } | null;
  status?: string;
  error?: { code?: number; message?: string; type?: string } | null;
};
type FBStatic = {
  init: (options: { appId: string; version: string; xfbml?: boolean; cookie?: boolean }) => void;
  login: (cb: (response: FBLoginResponse) => void, options: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    FB?: FBStatic;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FBStatic> | null = null;

export function loadFacebookSdk(appId: string, version: string): Promise<FBStatic> {
  if (window.FB) return Promise.resolve(window.FB);
  if (loading) return loading;
  loading = new Promise<FBStatic>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, version, xfbml: false, cookie: false });
      resolve(window.FB!);
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      loading = null;
      reject(new Error("Facebook SDK failed to load"));
    };
    document.body.appendChild(script);
  });
  return loading;
}

/** Resolves with the code to exchange on the server, or null if the owner cancelled. */
export async function facebookBusinessLogin(appId: string, version: string, configId: string): Promise<string | null> {
  const FB = await loadFacebookSdk(appId, version);
  return new Promise((resolve, reject) => {
    FB.login((response) => {
      if (response.error) {
        reject(new Error("facebook_login_failed"));
        return;
      }
      resolve(response.authResponse?.code ?? null);
    }, {
      config_id: configId,
      response_type: "code",
      override_default_response_type: true,
    });
  });
}

/** Shrink a photo to at most `max` px on its long side, as a JPEG data URL. */
export function resizeImage(file: File, max = 1200, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Not an image"));
    };
    img.src = url;
  });
}
