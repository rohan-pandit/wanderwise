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
          correlation_id: string | null;
          name: string | null;
          slug: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          user_id: string;
          status?: string;
          correlation_id?: string | null;
          name?: string | null;
          slug?: string | null;
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
          correlation_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          role: "user" | "assistant" | "system";
          content: string;
          correlation_id?: string | null;
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
      feedback: {
        Row: {
          id: string;
          trip_id: string;
          categories: string[];
          message: string | null;
          context: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          trip_id: string;
          categories?: string[];
          message?: string | null;
          context: string;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["feedback"]["Insert"]>;
      };
      workflow_runs: {
        Row: {
          id: string;
          trip_id: string;
          status: string;
          started_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          trip_id: string;
          status: string;
          started_at?: string;
          completed_at?: string | null;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["workflow_runs"]["Insert"]>;
      };
      workflow_steps: {
        Row: {
          id: string;
          workflow_run_id: string;
          from_state: string | null;
          to_state: string | null;
          event: string;
          actor: string;
          correlation_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workflow_run_id: string;
          from_state?: string | null;
          to_state?: string | null;
          event: string;
          actor: string;
          correlation_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["workflow_steps"]["Insert"]>;
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
          origin_id: string | null;
          destination: string;
          destination_id: string | null;
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
          source: string;
          origin_airport_code: string | null;
          destination_airport_code: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          origin: string;
          origin_id?: string | null;
          destination: string;
          destination_id?: string | null;
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
          source?: string;
          origin_airport_code?: string | null;
          destination_airport_code?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "flights_origin_id_fkey";
            columns: ["origin_id"];
            referencedRelation: "destinations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flights_destination_id_fkey";
            columns: ["destination_id"];
            referencedRelation: "destinations";
            referencedColumns: ["id"];
          },
        ];
        Update: Partial<Database["public"]["Tables"]["flights"]["Insert"]>;
      };
      hotels: {
        Row: {
          id: string;
          destination: string;
          destination_id: string;
          name: string;
          neighborhood: string | null;
          price_per_night_usd: number;
          taxes_fees_usd: number;
          rating: number | null;
          room_capacity: number;
          available_rooms: number;
          amenities: string[] | null;
          cancellation_policy: string | null;
          vibe_tags: string[] | null;
          inventory_version: number;
        };
        Insert: {
          id?: string;
          destination: string;
          destination_id: string;
          name: string;
          neighborhood?: string | null;
          price_per_night_usd: number;
          taxes_fees_usd?: number;
          rating?: number | null;
          room_capacity?: number;
          available_rooms?: number;
          amenities?: string[] | null;
          cancellation_policy?: string | null;
          vibe_tags?: string[] | null;
          inventory_version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "hotels_destination_id_fkey";
            columns: ["destination_id"];
            referencedRelation: "destinations";
            referencedColumns: ["id"];
          },
        ];
        Update: Partial<Database["public"]["Tables"]["hotels"]["Insert"]>;
      };
      activities: {
        Row: {
          id: string;
          destination: string;
          destination_id: string;
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
          destination_id: string;
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
        Relationships: [
          {
            foreignKeyName: "activities_destination_id_fkey";
            columns: ["destination_id"];
            referencedRelation: "destinations";
            referencedColumns: ["id"];
          },
        ];
        Update: Partial<Database["public"]["Tables"]["activities"]["Insert"]>;
      };
      agent_runs: {
        Row: {
          id: string;
          session_id: string | null;
          trip_id: string | null;
          workflow_run_id: string | null;
          agent_name: string;
          prompt_version: string | null;
          model: string | null;
          input_state_version: number | null;
          output_state_version: number | null;
          input_tokens: number | null;
          output_tokens: number | null;
          cache_read_tokens: number | null;
          cache_write_tokens: number | null;
          latency_ms: number | null;
          cost_usd: number | null;
          status: "success" | "error" | "guardrail_blocked";
          error_message: string | null;
          correlation_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id?: string | null;
          trip_id?: string | null;
          workflow_run_id?: string | null;
          agent_name: string;
          prompt_version?: string | null;
          model?: string | null;
          input_state_version?: number | null;
          output_state_version?: number | null;
          input_tokens?: number | null;
          output_tokens?: number | null;
          cache_read_tokens?: number | null;
          cache_write_tokens?: number | null;
          latency_ms?: number | null;
          cost_usd?: number | null;
          status: "success" | "error" | "guardrail_blocked";
          error_message?: string | null;
          correlation_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["agent_runs"]["Insert"]>;
      };
      tool_calls: {
        Row: {
          id: string;
          agent_run_id: string;
          tool_name: string;
          arguments: Json;
          result: Json | null;
          duration_ms: number | null;
          status: "success" | "error";
          created_at: string;
        };
        Insert: {
          id?: string;
          agent_run_id: string;
          tool_name: string;
          arguments: Json;
          result?: Json | null;
          duration_ms?: number | null;
          status: "success" | "error";
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["tool_calls"]["Insert"]>;
      };
      guardrail_events: {
        Row: {
          id: string;
          session_id: string | null;
          trip_id: string | null;
          agent_name: string | null;
          guardrail_name: string;
          layer: "input_scope" | "output_validation" | "domain_validation" | "workflow_authorization";
          triggered: boolean;
          detail: string | null;
          workflow_run_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id?: string | null;
          trip_id?: string | null;
          agent_name?: string | null;
          guardrail_name: string;
          layer: "input_scope" | "output_validation" | "domain_validation" | "workflow_authorization";
          triggered: boolean;
          detail?: string | null;
          workflow_run_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["guardrail_events"]["Insert"]>;
      };
      eval_runs: {
        Row: {
          id: string;
          run_label: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          run_label?: string | null;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["eval_runs"]["Insert"]>;
      };
      eval_results: {
        Row: {
          id: string;
          eval_run_id: string;
          test_case_name: string;
          passed: boolean;
          score: number | null;
          details: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          eval_run_id: string;
          test_case_name: string;
          passed: boolean;
          score?: number | null;
          details?: Json | null;
          created_at?: string;
        };
        Relationships: [];
        Update: Partial<Database["public"]["Tables"]["eval_results"]["Insert"]>;
      };
    };
    Views: Record<string, never>;
    Functions: {
      match_destinations: {
        Args: {
          query_embedding: string;
          match_count: number;
          filter_inventory_version: number;
          filter_max_daily_cost_usd?: number | null;
          filter_vibe_tags?: string[] | null;
        };
        Returns: {
          id: string;
          name: string;
          country: string | null;
          time_zone: string | null;
          description: string | null;
          vibe_tags: string[] | null;
          seasonality: Json | null;
          estimated_daily_cost_usd: number | null;
          inventory_version: number;
          similarity: number;
        }[];
      };
      match_activities: {
        Args: {
          query_embedding: string;
          match_count: number;
          filter_destination_id: string;
          filter_inventory_version: number;
          filter_min_price_usd?: number | null;
          filter_max_price_usd?: number | null;
          filter_required_accessibility?: string[] | null;
          filter_vibe_tags?: string[] | null;
        };
        Returns: {
          id: string;
          destination: string;
          destination_id: string;
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
          similarity: number;
        }[];
      };
    };
    Enums: Record<string, never>;
  };
}
