"use server"

import { LLMConfig, LLMProvider, testLLMProvider } from "@/ai/providers/llmProvider"
import {
  categoryFormSchema,
  currencyFormSchema,
  fieldFormSchema,
  projectFormSchema,
  settingsFormSchema,
} from "@/forms/settings"
import { organizationBusinessFormSchema, userFormSchema } from "@/forms/users"
import { ActionState } from "@/lib/actions"
import { getCurrentUser } from "@/lib/auth"
import { requireOrg } from "@/lib/authz"
import config from "@/lib/config"
import { uploadStaticImage } from "@/lib/uploads"
import { codeFromName, randomHexColor } from "@/lib/utils"
import { createCategory, deleteCategory, updateCategory } from "@/models/categories"
import { createCurrency, deleteCurrency, updateCurrency } from "@/models/currencies"
import { createField, deleteField, updateField } from "@/models/fields"
import { updateOrganization } from "@/models/organizations"
import { createProject, deleteProject, DimensionInUseError, updateProject } from "@/models/projects"
import { SELF_HOSTED_ONLY_SETTINGS, SettingsMap, updateSettings } from "@/models/settings"
import { updateUser } from "@/models/users"
import { Organization, Prisma, User } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import path from "path"

const SELF_HOSTED_ONLY_SETTINGS_SET = new Set<string>(SELF_HOSTED_ONLY_SETTINGS)

/** Settings de organización y claves LLM: ADMIN (matriz de roles, skill supabase-multitenant). */
export async function saveSettingsAction(
  _prevState: ActionState<SettingsMap> | null,
  formData: FormData
): Promise<ActionState<SettingsMap>> {
  const { db } = await requireOrg("ADMIN")
  const validatedForm = settingsFormSchema.safeParse(Object.fromEntries(formData))

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  for (const key in validatedForm.data) {
    if (SELF_HOSTED_ONLY_SETTINGS_SET.has(key) && !config.selfHosted.isEnabled) {
      continue
    }
    const value = validatedForm.data[key as keyof typeof validatedForm.data]
    if (value !== undefined) {
      await updateSettings(db, key, value)
    }
  }

  revalidatePath("/settings/currencies")
  revalidatePath("/settings/categories")
  revalidatePath("/settings/llm")
  return { success: true }
}

export async function testLLMProviderAction(
  provider: string,
  apiKey: string,
  model: string,
  baseUrl?: string
): Promise<{ success: boolean; supportsVision: boolean; message: string }> {
  await requireOrg("ADMIN")
  const config: LLMConfig = {
    provider: provider as LLMProvider,
    apiKey,
    model,
    baseUrl,
  }
  return testLLMProvider(config)
}

/** Perfil personal (nombre y avatar): NO requiere rol, es un dato del usuario. */
export async function saveProfileAction(
  _prevState: ActionState<User> | null,
  formData: FormData
): Promise<ActionState<User>> {
  const user = await getCurrentUser()
  // La organización activa sólo se necesita para contar la cuota de disco del avatar.
  const { org } = await requireOrg("VIEWER")
  const validatedForm = userFormSchema.safeParse(Object.fromEntries(formData))

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  // Upload avatar
  let avatarUrl = user.avatar
  const avatarFile = formData.get("avatar") as File | null
  if (avatarFile instanceof File && avatarFile.size > 0) {
    try {
      const uploadedAvatarPath = await uploadStaticImage(user, org, avatarFile, "avatar.webp", 500, 500)
      avatarUrl = `/files/static/${path.basename(uploadedAvatarPath)}`
    } catch (error) {
      return { success: false, error: "Failed to upload avatar: " + error }
    }
  }

  await updateUser(user.id, {
    name: validatedForm.data.name !== undefined ? validatedForm.data.name : user.name,
    avatar: avatarUrl,
  })

  revalidatePath("/settings/profile")
  return { success: true }
}

/**
 * Datos de emisor de facturas: son de la ORGANIZACIÓN (T11), no del usuario.
 * Sólo ADMIN, igual que el resto de la configuración de la organización.
 */
export async function saveBusinessSettingsAction(
  _prevState: ActionState<Organization> | null,
  formData: FormData
): Promise<ActionState<Organization>> {
  const { org, user } = await requireOrg("ADMIN")
  const validatedForm = organizationBusinessFormSchema.safeParse(Object.fromEntries(formData))

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  let businessLogoUrl = org.businessLogo
  const businessLogoFile = formData.get("businessLogo") as File | null
  if (businessLogoFile instanceof File && businessLogoFile.size > 0) {
    try {
      const uploadedBusinessLogoPath = await uploadStaticImage(user, org, businessLogoFile, "businessLogo.png", 500, 500)
      businessLogoUrl = `/files/static/${path.basename(uploadedBusinessLogoPath)}`
    } catch (error) {
      return { success: false, error: "Failed to upload business logo: " + error }
    }
  }

  const organization = await updateOrganization(org.id, {
    businessName: validatedForm.data.businessName ?? org.businessName,
    businessAddress: validatedForm.data.businessAddress ?? org.businessAddress,
    businessBankDetails: validatedForm.data.businessBankDetails ?? org.businessBankDetails,
    businessLogo: businessLogoUrl,
  })

  revalidatePath("/settings/profile")
  return { success: true, data: organization }
}

export async function addProjectAction(data: Prisma.ProjectCreateInput) {
  const { db } = await requireOrg("EDITOR")
  const validatedForm = projectFormSchema.safeParse(data)

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  const project = await createProject(db, {
    code: codeFromName(validatedForm.data.name),
    name: validatedForm.data.name,
    llm_prompt: validatedForm.data.llm_prompt || null,
    color: validatedForm.data.color || randomHexColor(),
  })
  revalidatePath("/settings/projects")

  return { success: true, project }
}

export async function editProjectAction(code: string, data: Prisma.ProjectUpdateInput) {
  const { db } = await requireOrg("EDITOR")
  const validatedForm = projectFormSchema.safeParse(data)

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  const project = await updateProject(db, code, {
    name: validatedForm.data.name,
    llm_prompt: validatedForm.data.llm_prompt,
    color: validatedForm.data.color || "",
  })
  revalidatePath("/settings/projects")

  return { success: true, project }
}

export async function deleteProjectAction(code: string) {
  const { db } = await requireOrg("EDITOR")
  try {
    await deleteProject(db, code)
  } catch (error) {
    // E4: `DIMENSION_IN_USE` es una respuesta de negocio, no un fallo técnico.
    if (error instanceof DimensionInUseError) return { success: false, error: error.message }
    return { success: false, error: "Failed to delete project" + error }
  }
  revalidatePath("/settings/projects")
  return { success: true }
}

export async function addCurrencyAction(data: Prisma.CurrencyCreateInput) {
  const { db } = await requireOrg("EDITOR")
  const validatedForm = currencyFormSchema.safeParse(data)

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  const currency = await createCurrency(db, {
    code: validatedForm.data.code,
    name: validatedForm.data.name,
  })
  revalidatePath("/settings/currencies")

  return { success: true, currency }
}

export async function editCurrencyAction(code: string, data: Prisma.CurrencyUpdateInput) {
  const { db } = await requireOrg("EDITOR")
  const validatedForm = currencyFormSchema.safeParse(data)

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  const currency = await updateCurrency(db, code, { name: validatedForm.data.name })
  revalidatePath("/settings/currencies")
  return { success: true, currency }
}

export async function deleteCurrencyAction(code: string) {
  const { db } = await requireOrg("EDITOR")
  try {
    await deleteCurrency(db, code)
  } catch (error) {
    return { success: false, error: "Failed to delete currency" + error }
  }
  revalidatePath("/settings/currencies")
  return { success: true }
}

/** Categorías: configuración de clasificación → ADMIN. */
export async function addCategoryAction(data: Prisma.CategoryCreateInput) {
  const { db } = await requireOrg("ADMIN")
  const validatedForm = categoryFormSchema.safeParse(data)

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  const code = codeFromName(validatedForm.data.name)
  try {
    const category = await createCategory(db, {
      code,
      name: validatedForm.data.name,
      llm_prompt: validatedForm.data.llm_prompt,
      color: validatedForm.data.color || "",
    })
    revalidatePath("/settings/categories")

    return { success: true, category }
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return {
        success: false,
        error: `Category with the code "${code}" already exists. Try a different name.`,
      }
    }
    return { success: false, error: "Failed to create category" }
  }
}

export async function editCategoryAction(code: string, data: Prisma.CategoryUpdateInput) {
  const { db } = await requireOrg("ADMIN")
  const validatedForm = categoryFormSchema.safeParse(data)

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  const category = await updateCategory(db, code, {
    name: validatedForm.data.name,
    llm_prompt: validatedForm.data.llm_prompt,
    color: validatedForm.data.color || "",
  })
  revalidatePath("/settings/categories")

  return { success: true, category }
}

export async function deleteCategoryAction(code: string) {
  const { db } = await requireOrg("ADMIN")
  try {
    await deleteCategory(db, code)
  } catch (error) {
    return { success: false, error: "Failed to delete category" + error }
  }
  revalidatePath("/settings/categories")
  return { success: true }
}

/** Campos personalizados: definen el esquema de datos de la organización → ADMIN. */
export async function addFieldAction(data: Prisma.FieldCreateInput) {
  const { db } = await requireOrg("ADMIN")
  const validatedForm = fieldFormSchema.safeParse(data)

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  const field = await createField(db, {
    code: codeFromName(validatedForm.data.name),
    name: validatedForm.data.name,
    type: validatedForm.data.type,
    llm_prompt: validatedForm.data.llm_prompt,
    isVisibleInList: validatedForm.data.isVisibleInList,
    isVisibleInAnalysis: validatedForm.data.isVisibleInAnalysis,
    isRequired: validatedForm.data.isRequired,
    isExtra: true,
  })
  revalidatePath("/settings/fields")

  return { success: true, field }
}

export async function editFieldAction(code: string, data: Prisma.FieldUpdateInput) {
  const { db } = await requireOrg("ADMIN")
  const validatedForm = fieldFormSchema.safeParse(data)

  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.message }
  }

  const field = await updateField(db, code, {
    name: validatedForm.data.name,
    type: validatedForm.data.type,
    llm_prompt: validatedForm.data.llm_prompt,
    isVisibleInList: validatedForm.data.isVisibleInList,
    isVisibleInAnalysis: validatedForm.data.isVisibleInAnalysis,
    isRequired: validatedForm.data.isRequired,
  })
  revalidatePath("/settings/fields")

  return { success: true, field }
}

export async function deleteFieldAction(code: string) {
  const { db } = await requireOrg("ADMIN")
  try {
    await deleteField(db, code)
  } catch (error) {
    return { success: false, error: "Failed to delete field" + error }
  }
  revalidatePath("/settings/fields")
  return { success: true }
}
