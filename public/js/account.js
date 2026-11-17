function resizeImageFileToDataUrl(file, size = 128) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Unsupported image format."));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
        let dataUrl = canvas.toDataURL("image/webp", 0.85);
        if (!dataUrl.startsWith("data:image/webp")) {
          dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        }
        resolve(dataUrl);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function createAccountController({ onUserChange } = {}) {
  const openBtn = document.getElementById("account-btn");
  const modal = document.getElementById("account-modal");
  const closeBtn = document.getElementById("account-close-btn");

  const stepEmail = document.getElementById("auth-step-email");
  const emailForm = document.getElementById("auth-email-form");
  const emailInput = document.getElementById("auth-email-input");
  const sendBtn = document.getElementById("auth-send-btn");

  const stepCode = document.getElementById("auth-step-code");
  const codeSubtitle = document.getElementById("auth-code-subtitle");
  const devBanner = document.getElementById("auth-dev-banner");
  const devCodeText = document.getElementById("auth-dev-code");
  const devFillBtn = document.getElementById("auth-dev-fill");
  const codeForm = document.getElementById("auth-code-form");
  const codeInput = document.getElementById("auth-code-input");
  const verifyBtn = document.getElementById("auth-verify-btn");
  const resendBtn = document.getElementById("auth-resend-btn");
  const changeEmailBtn = document.getElementById("auth-change-email");

  const stepProfile = document.getElementById("auth-step-profile");
  const avatarEl = document.getElementById("auth-avatar");
  const avatarUploadInput = document.getElementById("auth-pfp-file");
  const avatarUploadBtn = document.getElementById("auth-pfp-upload-btn");
  const avatarRemoveBtn = document.getElementById("auth-pfp-remove-btn");
  const ownerBadge = document.getElementById("auth-owner-badge");
  const profileEmail = document.getElementById("auth-profile-email");
  const profileSince = document.getElementById("auth-profile-since");
  const profileForm = document.getElementById("auth-profile-form");
  const nameInput = document.getElementById("auth-name-input");
  const statEngine = document.getElementById("auth-stat-engine");
  const statGames = document.getElementById("auth-stat-games");
  const statTracks = document.getElementById("auth-stat-tracks");
  const logoutBtn = document.getElementById("auth-logout-btn");
  const deleteBtn = document.getElementById("auth-delete-btn");

  const errorEl = document.getElementById("auth-error");

  let currentUser = null;
  let pendingEmail = "";
  let cooldownTimer = null;
  let cooldownEndsAt = 0;

  function setError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || "";
    errorEl.classList.toggle("hidden", !msg);
  }

  function renderAvatarInto(container, user, imgClass) {
    if (!container) return;
    container.innerHTML = "";
    if (user?.avatarUrl) {
      const img = document.createElement("img");
      img.className = imgClass;
      img.src = user.avatarUrl;
      img.alt = user.displayName || "PFP";
      img.addEventListener("error", () => {
        container.textContent = (
          user.displayName?.[0] ||
          user.email?.[0] ||
          "S"
        ).toUpperCase();
      });
      container.appendChild(img);
    } else {
      container.textContent = (
        user?.displayName?.[0] ||
        user?.email?.[0] ||
        "S"
      ).toUpperCase();
    }
  }

  function updateNavButton() {
    if (!openBtn) return;
    openBtn.innerHTML = "";
    if (currentUser) {
      if (currentUser.avatarUrl) {
        const img = document.createElement("img");
        img.className = "nav-pfp";
        img.src = currentUser.avatarUrl;
        img.alt = "";
        openBtn.appendChild(img);
      }
      const label = document.createElement("span");
      label.textContent = currentUser.displayName || currentUser.email.split("@")[0];
      openBtn.appendChild(label);
      openBtn.classList.add("signed-in");
      openBtn.title = `Signed in as ${currentUser.email}`;
    } else {
      openBtn.textContent = "Sign in";
      openBtn.classList.remove("signed-in");
      openBtn.title = "Sign in with email";
    }
  }

  function renderProfileStats() {
    if (!currentUser) return;
    const prefs = currentUser.preferences || {};
    renderAvatarInto(avatarEl, currentUser, "auth-avatar-img");
    ownerBadge?.classList.toggle("hidden", !currentUser.isOwner);
    avatarRemoveBtn?.classList.toggle("hidden", !currentUser.avatarUrl);
    profileEmail.textContent = currentUser.email;
    try {
      profileSince.textContent = `Joined ${new Date(currentUser.createdAt).toLocaleDateString()}`;
    } catch {
      profileSince.textContent = "Active account";
    }
    nameInput.value = currentUser.displayName || "";
    statEngine.textContent = prefs.searchEngine || "ddg_html";
    statGames.textContent = String(prefs.favoriteGames?.length || 0);
    statTracks.textContent = String(prefs.savedTracks?.length || 0);
  }

  function showStep(step) {
    setError("");
    stepEmail.classList.toggle("hidden", step !== "email");
    stepCode.classList.toggle("hidden", step !== "code");
    stepProfile.classList.toggle("hidden", step !== "profile");
  }

  function startCooldown(seconds = 30) {
    clearInterval(cooldownTimer);
    cooldownEndsAt = Date.now() + seconds * 1000;
    const tick = () => {
      const rem = Math.ceil((cooldownEndsAt - Date.now()) / 1000);
      if (rem <= 0) {
        clearInterval(cooldownTimer);
        resendBtn.disabled = false;
        resendBtn.textContent = "Resend code";
      } else {
        resendBtn.disabled = true;
        resendBtn.textContent = `Resend (${rem}s)`;
      }
    };
    tick();
    cooldownTimer = setInterval(tick, 500);
  }

  function openModal() {
    if (!modal) return;
    modal.classList.remove("hidden");
    if (currentUser) {
      renderProfileStats();
      showStep("profile");
    } else if (pendingEmail) {
      showStep("code");
      codeInput.focus();
    } else {
      showStep("email");
      emailInput.focus();
    }
  }

  function closeModal() {
    modal?.classList.add("hidden");
    setError("");
  }

  function setUser(user) {
    currentUser = user || null;
    updateNavButton();
    if (currentUser) renderProfileStats();
    onUserChange?.(currentUser);
  }

  async function patchProfile(payload) {
    setError("");
    const res = await fetch("/api/auth/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data?.error || "Failed to update profile.");
      return null;
    }
    setUser(data.user);
    return data.user;
  }

  async function requestOtp(email) {
    setError("");
    sendBtn.disabled = true;
    resendBtn.disabled = true;
    const origText = sendBtn.textContent;
    sendBtn.textContent = "Sending...";

    try {
      const res = await fetch("/api/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.retryAfterSec) startCooldown(data.retryAfterSec);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      pendingEmail = data.email;
      codeSubtitle.textContent = `Enter the 6-digit code sent to ${pendingEmail}`;
      if (data.devCode) {
        devCodeText.textContent = data.devCode;
        devBanner.classList.remove("hidden");
      } else {
        devBanner.classList.add("hidden");
      }
      codeInput.value = "";
      showStep("code");
      startCooldown(30);
      codeInput.focus();
    } catch (err) {
      setError(err?.message || "Failed to send verification code.");
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = origText;
    }
  }

  async function refreshSession() {
    try {
      const res = await fetch("/api/auth/me");
      if (!res.ok) return null;
      const data = await res.json();
      setUser(data?.authenticated ? data.user : null);
      return currentUser;
    } catch {
      return null;
    }
  }

  async function updatePreferences(partialPrefs) {
    if (!currentUser) return null;
    try {
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: partialPrefs }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.user) {
        currentUser = data.user;
        renderProfileStats();
      }
      return currentUser;
    } catch {
      return null;
    }
  }

  // Event bindings
  openBtn?.addEventListener("click", openModal);
  closeBtn?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && !modal.classList.contains("hidden")) {
      closeModal();
    }
  });

  emailForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    requestOtp(emailInput.value);
  });

  resendBtn?.addEventListener("click", () => {
    if (pendingEmail) requestOtp(pendingEmail);
  });

  changeEmailBtn?.addEventListener("click", () => {
    pendingEmail = "";
    devBanner.classList.add("hidden");
    showStep("email");
    emailInput.focus();
  });

  devFillBtn?.addEventListener("click", () => {
    codeInput.value = devCodeText.textContent.trim();
    codeInput.focus();
  });

  codeForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("");
    verifyBtn.disabled = true;
    const orig = verifyBtn.textContent;
    verifyBtn.textContent = "Verifying...";

    try {
      const res = await fetch("/api/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingEmail, code: codeInput.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      pendingEmail = "";
      devBanner.classList.add("hidden");
      setUser(data.user);
      showStep("profile");
    } catch (err) {
      setError(err?.message || "Invalid code.");
    } finally {
      verifyBtn.disabled = false;
      verifyBtn.textContent = orig;
    }
  });

  profileForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await patchProfile({ displayName: nameInput.value });
  });

  avatarUploadBtn?.addEventListener("click", () => avatarUploadInput?.click());
  avatarUploadInput?.addEventListener("change", async () => {
    const file = avatarUploadInput.files?.[0];
    avatarUploadInput.value = "";
    if (!file) return;
    try {
      const dataUrl = await resizeImageFileToDataUrl(file, 128);
      await patchProfile({ avatarUrl: dataUrl });
    } catch (err) {
      setError(err?.message || "Failed to process image.");
    }
  });

  avatarRemoveBtn?.addEventListener("click", async () => {
    await patchProfile({ avatarUrl: "" });
  });

  logoutBtn?.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    showStep("email");
    closeModal();
  });

  deleteBtn?.addEventListener("click", async () => {
    if (!confirm("Delete your Simple account and saved preferences?")) return;
    const res = await fetch("/api/auth/account", { method: "DELETE" });
    if (res.ok) {
      setUser(null);
      showStep("email");
      closeModal();
    }
  });

  return {
    getUser: () => currentUser,
    refreshSession,
    updatePreferences,
    openModal,
  };
}
