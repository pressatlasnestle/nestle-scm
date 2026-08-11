export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json | null
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value?: Json | null
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "app_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      articles: {
        Row: {
          ai_category: string | null
          ai_relevance_score: number | null
          ai_sentiment: string | null
          ai_sorting_flagged: boolean | null
          ai_sorting_reasoning: string | null
          ai_sorting_status: string | null
          ai_summary: string | null
          ai_tags: string[]
          ai_themes: string[] | null
          alt_urls: string[]
          body: string | null
          body_purged_at: string | null
          byline: string | null
          coded_status: string | null
          dedup_key: string
          headline: string
          id: string
          ingested_at: string
          keyword_mention_count: number | null
          matched_keywords: string[]
          matched_negative_keywords: string[] | null
          media: string | null
          published_at: string | null
          source_channel: string | null
          source_id: string | null
          status: string
          status_changed_at: string | null
          status_changed_by: string | null
          url: string | null
          word_count: number | null
        }
        Insert: {
          ai_category?: string | null
          ai_relevance_score?: number | null
          ai_sentiment?: string | null
          ai_sorting_flagged?: boolean | null
          ai_sorting_reasoning?: string | null
          ai_sorting_status?: string | null
          ai_summary?: string | null
          ai_tags?: string[]
          ai_themes?: string[] | null
          alt_urls?: string[]
          body?: string | null
          body_purged_at?: string | null
          byline?: string | null
          coded_status?: string | null
          dedup_key: string
          headline: string
          id?: string
          ingested_at?: string
          keyword_mention_count?: number | null
          matched_keywords?: string[]
          matched_negative_keywords?: string[] | null
          media?: string | null
          published_at?: string | null
          source_channel?: string | null
          source_id?: string | null
          status?: string
          status_changed_at?: string | null
          status_changed_by?: string | null
          url?: string | null
          word_count?: number | null
        }
        Update: {
          ai_category?: string | null
          ai_relevance_score?: number | null
          ai_sentiment?: string | null
          ai_sorting_flagged?: boolean | null
          ai_sorting_reasoning?: string | null
          ai_sorting_status?: string | null
          ai_summary?: string | null
          ai_tags?: string[]
          ai_themes?: string[] | null
          alt_urls?: string[]
          body?: string | null
          body_purged_at?: string | null
          byline?: string | null
          coded_status?: string | null
          dedup_key?: string
          headline?: string
          id?: string
          ingested_at?: string
          keyword_mention_count?: number | null
          matched_keywords?: string[]
          matched_negative_keywords?: string[] | null
          media?: string | null
          published_at?: string | null
          source_channel?: string | null
          source_id?: string | null
          status?: string
          status_changed_at?: string | null
          status_changed_by?: string | null
          url?: string | null
          word_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "articles_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "articles_status_changed_by_fkey"
            columns: ["status_changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string | null
          actor_id: string | null
          created_at: string
          id: string
          metadata: Json | null
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action?: string | null
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string | null
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ingestion_runs: {
        Row: {
          articles_duplicate: number | null
          articles_found: number | null
          articles_new: number | null
          articles_skipped_paywall: number | null
          articles_suppressed_exclusion: number | null
          completed_at: string | null
          errors: Json | null
          id: string
          run_type: string
          sources_checked: number | null
          started_at: string
          status: string
          triggered_by: string | null
          window_end: string | null
          window_start: string | null
        }
        Insert: {
          articles_duplicate?: number | null
          articles_found?: number | null
          articles_new?: number | null
          articles_skipped_paywall?: number | null
          articles_suppressed_exclusion?: number | null
          completed_at?: string | null
          errors?: Json | null
          id?: string
          run_type: string
          sources_checked?: number | null
          started_at?: string
          status?: string
          triggered_by?: string | null
          window_end?: string | null
          window_start?: string | null
        }
        Update: {
          articles_duplicate?: number | null
          articles_found?: number | null
          articles_new?: number | null
          articles_skipped_paywall?: number | null
          articles_suppressed_exclusion?: number | null
          completed_at?: string | null
          errors?: Json | null
          id?: string
          run_type?: string
          sources_checked?: number | null
          started_at?: string
          status?: string
          triggered_by?: string | null
          window_end?: string | null
          window_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_runs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_secrets: {
        Row: {
          id: string
          is_set: boolean
          last_four: string | null
          model_id: string | null
          provider: string
          updated_at: string | null
          updated_by: string | null
          vault_secret_id: string | null
        }
        Insert: {
          id?: string
          is_set?: boolean
          last_four?: string | null
          model_id?: string | null
          provider: string
          updated_at?: string | null
          updated_by?: string | null
          vault_secret_id?: string | null
        }
        Update: {
          id?: string
          is_set?: boolean
          last_four?: string | null
          model_id?: string | null
          provider?: string
          updated_at?: string | null
          updated_by?: string | null
          vault_secret_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "integration_secrets_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      keywords: {
        Row: {
          added_by: string | null
          cluster: string | null
          created_at: string
          gate: string | null
          id: string
          is_active: boolean
          keyword: string
          list_type: string
          match_type: string | null
          notes: string | null
          variations: string[] | null
        }
        Insert: {
          added_by?: string | null
          cluster?: string | null
          created_at?: string
          gate?: string | null
          id?: string
          is_active?: boolean
          keyword: string
          list_type?: string
          match_type?: string | null
          notes?: string | null
          variations?: string[] | null
        }
        Update: {
          added_by?: string | null
          cluster?: string | null
          created_at?: string
          gate?: string | null
          id?: string
          is_active?: boolean
          keyword?: string
          list_type?: string
          match_type?: string | null
          notes?: string | null
          variations?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "keywords_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          invited_by: string | null
          is_active: boolean
          role: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          invited_by?: string | null
          is_active?: boolean
          role?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          invited_by?: string | null
          is_active?: boolean
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      report_recipients: {
        Row: {
          added_by: string | null
          created_at: string
          email: string
          id: string
          is_active: boolean
          name: string | null
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          email: string
          id?: string
          is_active?: boolean
          name?: string | null
        }
        Update: {
          added_by?: string | null
          created_at?: string
          email?: string
          id?: string
          is_active?: boolean
          name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "report_recipients_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          article_count: number | null
          created_by: string | null
          generated_at: string | null
          html_content: string | null
          id: string
          recipient_count: number | null
          sent_at: string | null
          stats_snapshot: Json | null
          status: string
          week_of: string | null
        }
        Insert: {
          article_count?: number | null
          created_by?: string | null
          generated_at?: string | null
          html_content?: string | null
          id?: string
          recipient_count?: number | null
          sent_at?: string | null
          stats_snapshot?: Json | null
          status?: string
          week_of?: string | null
        }
        Update: {
          article_count?: number | null
          created_by?: string | null
          generated_at?: string | null
          html_content?: string | null
          id?: string
          recipient_count?: number | null
          sent_at?: string | null
          stats_snapshot?: Json | null
          status?: string
          week_of?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sources: {
        Row: {
          added_by: string | null
          category: string | null
          content_type: string | null
          created_at: string
          handling_notes: string | null
          id: string
          is_active: boolean
          last_fetch_error: string | null
          last_fetch_status: string | null
          last_fetched_at: string | null
          list_type: string | null
          name: string
          priority: string | null
          region: string | null
          rss_url: string | null
          tier: string | null
          website_domain: string | null
        }
        Insert: {
          added_by?: string | null
          category?: string | null
          content_type?: string | null
          created_at?: string
          handling_notes?: string | null
          id?: string
          is_active?: boolean
          last_fetch_error?: string | null
          last_fetch_status?: string | null
          last_fetched_at?: string | null
          list_type?: string | null
          name: string
          priority?: string | null
          region?: string | null
          rss_url?: string | null
          tier?: string | null
          website_domain?: string | null
        }
        Update: {
          added_by?: string | null
          category?: string | null
          content_type?: string | null
          created_at?: string
          handling_notes?: string | null
          id?: string
          is_active?: boolean
          last_fetch_error?: string | null
          last_fetch_status?: string | null
          last_fetched_at?: string | null
          list_type?: string | null
          name?: string
          priority?: string | null
          region?: string | null
          rss_url?: string | null
          tier?: string | null
          website_domain?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sources_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      integration_secrets_status: {
        Row: {
          is_set: boolean | null
          last_four: string | null
          model_id: string | null
          provider: string | null
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          is_set?: boolean | null
          last_four?: string | null
          model_id?: string | null
          provider?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          is_set?: boolean | null
          last_four?: string | null
          model_id?: string | null
          provider?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "integration_secrets_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      can_curate: { Args: never; Returns: boolean }
      current_app_role: { Args: never; Returns: string }
      get_integration_secret: {
        Args: { p_provider: string }
        Returns: string
      }
      is_admin: { Args: never; Returns: boolean }
      is_app_user: { Args: never; Returns: boolean }
      set_integration_secret: {
        Args: { p_provider: string; p_secret_value: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
