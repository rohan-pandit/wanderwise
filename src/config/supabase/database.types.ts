/**
 * Hand-written types mirroring supabase/migrations/0001_initial_schema.sql.
 *
 * Normally generated via `supabase gen types typescript`, but that command
 * requires Docker/Podman on PATH (spins up a local introspection
 * container), which is unavailable in this environment (see BUILD_LOG.md,
 * 2026-09-16 "Docker/local Supabase blocker" entry). Keep this in sync by
 * hand until Docker is available, then regenerate and diff.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      sessions: {
        Row: {
          id: string;
          user_id: string;
          created_at: string;
          status: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          created_at?: string;
          status?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["sessions"]["Insert"]>;
      };
      trips: {
        Row: {
          id: string;
          session_id: string;
          user_id: string;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          user_id: string;
          status?: string;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["trips"]["Insert"]>;
      };
      messages: {
        Row: {
          id: string;
          session_id: string;
          role: "user" | "assistant" | "system";
          content: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          role: "user" | "assistant" | "system";
          content: string;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["messages"]["Insert"]>;
      };
      trip_state_versions: {
        Row: {
          id: string;
          trip_id: string;
          version: number;
          state: Json;
          actor: string;
          operation_type: string;
          correlation_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          trip_id: string;
          version: number;
          state: Json;
          actor: string;
          operation_type: string;
          correlation_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<
          Database["public"]["Tables"]["trip_state_versions"]["Insert"]
        >;
      };
      trip_requirements: {
        Row: {
          id: string;
          trip_id: string;
          field: string;
          value: Json;
          unit: string | null;
          source: string;
          confidence: number | null;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          trip_id: string;
          field: string;
          value: Json;
          unit?: string | null;
          source: string;
          confidence?: number | null;
          status: string;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<
          Database["public"]["Tables"]["trip_requirements"]["Insert"]
        >;
      };
      trip_preferences: {
        Row: {
          id: string;
          trip_id: string;
          field: string;
          value: Json;
          source: string;
          confidence: number | null;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          trip_id: string;
          field: string;
          value: Json;
          source: string;
          confidence?: number | null;
          status: string;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<
          Database["public"]["Tables"]["trip_preferences"]["Insert"]
        >;
      };
      trip_decisions: {
        Row: {
          id: string;
          trip_id: string;
          field: string;
          value: Json;
          source: string;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          trip_id: string;
          field: string;
          value: Json;
          source: string;
          status: string;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<
          Database["public"]["Tables"]["trip_decisions"]["Insert"]
        >;
      };
      trip_events: {
        Row: {
          id: string;
          trip_id: string;
          event_type: string;
          payload: Json;
          correlation_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          trip_id: string;
          event_type: string;
          payload: Json;
          correlation_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["trip_events"]["Insert"]>;
      };
      approval_records: {
        Row: {
          id: string;
          trip_id: string;
          proposal_state_version: number;
          proposal_hash: string;
          approved_at: string | null;
          invalidated_at: string | null;
          invalidation_reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          trip_id: string;
          proposal_state_version: number;
          proposal_hash: string;
          approved_at?: string | null;
          invalidated_at?: string | null;
          invalidation_reason?: string | null;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<
          Database["public"]["Tables"]["approval_records"]["Insert"]
        >;
      };
      destinations: {
        Row: {
          id: string;
          name: string;
          country: string | null;
          time_zone: string | null;
          description: string | null;
          vibe_tags: string[] | null;
          seasonality: Json | null;
          estimated_daily_cost_usd: number | null;
          inventory_version: number;
          source: string;
          embedding: number[] | null;
        };
        Insert: {
          id?: string;
          name: string;
          country?: string | null;
          time_zone?: string | null;
          description?: string | null;
          vibe_tags?: string[] | null;
          seasonality?: Json | null;
          estimated_daily_cost_usd?: number | null;
          inventory_version?: number;
          source?: string;
          embedding?: number[] | null;
        };
        Relationships: [];
        Update: Partial<
          Database["public"]["Tables"]["destinations"]["Insert"]
        >;
      };
      flights: {
        Row: {
          id: string;
          origin: string;
          destination: string;
          departure_time: string;
          arrival_time: string;
          departure_time_zone: string | null;
          arrival_time_zone: string | null;
          airline: string | null;
          flight_number: string | null;
          price_usd: number;
          taxes_fees_usd: number;
          cabin: string | null;
          is_red_eye: boolean;
          duration_minutes: number | null;
          refundable: boolean;
          changeable: boolean;
          inventory_version: number;
        };
        Insert: {
          id?: string;
          origin: string;
          destination: string;
          departure_time: string;
          arrival_time: string;
          departure_time_zone?: string | null;
          arrival_time_zone?: string | null;
          airline?: string | null;
          flight_number?: string | null;
          price_usd: number;
          taxes_fees_usd?: number;
          cabin?: string | null;
          is_red_eye?: boolean;
          duration_minutes?: number | null;
          refundable?: boolean;
          changeable?: boolean;
          inventory_version?: number;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["flights"]["Insert"]>;
      };
      hotels: {
        Row: {
          id: string;
          destination: string;
          name: string;
          neighborhood: string | null;
          price_per_night_usd: number;
          taxes_fees_usd: number;
          rating: number | null;
          room_capacity: number;
          amenities: string[] | null;
          cancellation_policy: string | null;
          vibe_tags: string[] | null;
          inventory_version: number;
        };
        Insert: {
          id?: string;
          destination: string;
          name: string;
          neighborhood?: string | null;
          price_per_night_usd: number;
          taxes_fees_usd?: number;
          rating?: number | null;
          room_capacity?: number;
          amenities?: string[] | null;
          cancellation_policy?: string | null;
          vibe_tags?: string[] | null;
          inventory_version?: number;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["hotels"]["Insert"]>;
      };
      activities: {
        Row: {
          id: string;
          destination: string;
          name: string;
          description: string | null;
          category: string | null;
          vibe_tags: string[] | null;
          price_usd: number;
          duration_minutes: number | null;
          opening_hours: Json | null;
          closed_days: string[] | null;
          location: string | null;
          accessibility_attributes: string[] | null;
          reservation_required: boolean;
          inventory_version: number;
          embedding: number[] | null;
        };
        Insert: {
          id?: string;
          destination: string;
          name: string;
          description?: string | null;
          category?: string | null;
          vibe_tags?: string[] | null;
          price_usd?: number;
          duration_minutes?: number | null;
          opening_hours?: Json | null;
          closed_days?: string[] | null;
          location?: string | null;
          accessibility_attributes?: string[] | null;
          reservation_required?: boolean;
          inventory_version?: number;
          embedding?: number[] | null;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["activities"]["Insert"]>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
