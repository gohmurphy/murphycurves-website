// netlify/functions/flng-sizing.js
// FLNG Process Sizing Trend Analysis - Backend calculations

exports.handler = async (event, context) => {
    // Enhanced CORS headers for all responses
    const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
    };

    console.log('FLNG Sizing function invoked:', event.httpMethod);

    // Handle preflight OPTIONS request
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 200,
            headers,
            body: ""
        };
    }

    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: "Method not allowed" })
        };
    }

    try {
        const payload = JSON.parse(event.body || "{}");

        // Extract input parameters
        const {
            MTPA,
            AVAIL,
            OP_FRAC,
            T_AIR,
            T_SW,
            Y_L,
            f_BOG,
            scheme,
            r_MR_SMR,
            r_MR_C3MR,
            r_C3,
            SP_LNG_SMR,
            SP_LNG_C3MR,
            M_flow,
            M_power,
            P1_MR_LP,
            P2_MR_LP,
            P1_MR_HP,
            P2_MR_HP,
            P1_C3_LP,
            P2_C3_LP,
            P1_C3_HP,
            P2_C3_HP,
            P1_FG,
            T1_FG,
            P2_FG,
            P1_BOG,
            T1_BOG,
            P2_BOG,
            etaP_FG,
            etaP_BOG,
            H_stage,
            composition,
            CW_m3h_per_MWth,
            HO_kW_per_tph,
            IA_Nm3h_per_MWe,
            N2_Nm3h_per_tph,
            Flare_pct,
            R_C3_LPG,
            R_C4_LPG,
            R_C5_COND,
            prop_basis
        } = payload;

        // Validate critical inputs
        if (typeof MTPA !== "number" || MTPA <= 0 || MTPA > 10) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Invalid MTPA value. Must be between 0.1 and 10." })
            };
        }

        // === CORE CALCULATIONS (Previously in frontend) ===
        const R = 8.314; // kJ/kmol-K

        // Auto gas properties from composition
        function autoPropsFromComp(comp) {
            const MWs = { CH4: 16.043, C2: 30.07, C3: 44.097, C4: 58.124, C5p: 72.0, N2: 28.014, CO2: 44.01 };
            const total = comp.CH4 + comp.C2 + comp.C3 + comp.C4 + comp.C5p + comp.N2 + comp.CO2;
            const MW = (MWs.CH4 * comp.CH4 + MWs.C2 * comp.C2 + MWs.C3 * comp.C3 + MWs.C4 * comp.C4 + MWs.C5p * comp.C5p + MWs.N2 * comp.N2 + MWs.CO2 * comp.CO2) / total;
            const k = Math.max(1.20, Math.min(1.42, 1.31 - 0.02 * (1 - comp.CH4 / 100) - 0.01 * (comp.CO2 / 100) - 0.005 * (comp.N2 / 100)));
            const Z = Math.max(0.80, Math.min(1.02, 0.93 - 0.10 * (comp.CO2 / 100) - 0.04 * ((comp.C4 + comp.C5p + comp.C3) / 100)));
            const Y_auto = Math.max(0.80, Math.min(0.98, 0.94 - 0.10 * (comp.CO2 / 100) - 0.05 * (comp.N2 / 100) - 0.03 * ((comp.C4 + comp.C5p) / 100)));
            return { MW, k, Z, Y_auto };
        }

        // Calculate at given MTPA
        function computeAt(mtpa) {
            const avail = AVAIL / 100.0;
            const opf = OP_FRAC / 100.0;
            const LNG_th = mtpa / avail * 1e6 / 8760.0 * opf;

            const comp = autoPropsFromComp(composition);
            const Y = Y_L === null || Y_L === undefined ? comp.Y_auto : Y_L;
            const fBOG = f_BOG / 100.0;

            // Scheme parameters
            const SP = (scheme === 'C3MR' ? SP_LNG_C3MR : SP_LNG_SMR);
            const rMR = (scheme === 'C3MR' ? r_MR_C3MR : r_MR_SMR);

            // Environmental corrections
            const SPcorr = 1 + 0.004 * (T_AIR - 25) + 0.010 * (T_SW - 25);
            const Qcorr = 1 + 0.002 * (T_AIR - 25) + 0.008 * (T_SW - 25);

            const FG_tph = LNG_th / Y * M_flow;
            const MR_tph = LNG_th * rMR * M_flow;
            const C3_tph = (scheme === 'C3MR' ? LNG_th * r_C3 * M_flow : 0);
            const BOG_tph = LNG_th * fBOG * M_flow;
            const Q_MW = LNG_th * 900.0 / 3600.0 * Qcorr;
            const Pref_MW = LNG_th * SP / 1000.0 * SPcorr * M_power;

            // Compressor powers (polytropic)
            const T1_FG_K = T1_FG + 273.15;
            const T1_BOG_K = T1_BOG + 273.15;

            // Gas properties
            let kF = comp.k, ZF = comp.Z, MWF = comp.MW, etaPF = etaP_FG;
            if (prop_basis !== 'auto') {
                const vendor_props = {
                    vendor_15: { k: 1.32, Z: 0.92, MW: 16.46, etap: 0.86 },
                    vendor_24: { k: 1.30, Z: 0.92, MW: 16.50, etap: 0.86 }
                };
                if (vendor_props[prop_basis]) {
                    const vp = vendor_props[prop_basis];
                    kF = vp.k; ZF = vp.Z; MWF = vp.MW; etaPF = vp.etap;
                }
            }

            const Hpoly_FG = (R / MWF) * T1_FG_K / ZF * (kF / (kF - 1)) * (Math.pow(P2_FG / P1_FG, (kF - 1) / kF) - 1);
            const WFG = (FG_tph / 3.6) * Hpoly_FG / etaPF / 1000.0 * M_power;

            const kB = 1.31, ZB = 0.95, MWB = 16.043, etaPB = etaP_BOG;
            const Hpoly_BOG = (R / MWB) * T1_BOG_K / ZB * (kB / (kB - 1)) * (Math.pow(P2_BOG / P1_BOG, (kB - 1) / kB) - 1);
            const WBOG = (BOG_tph / 3.6) * Hpoly_BOG / etaPB / 1000.0 * M_power;

            // Head-based staging
            function head(k, Z, MW, T, P1, P2) { return (R / MW) * T / Z * (k / (k - 1)) * (Math.pow(P2 / P1, (k - 1) / k) - 1); }
            const stMR_LP = Math.max(1, Math.ceil(head(1.22, 0.95, 20.0, 300.0, P1_MR_LP, P2_MR_LP) / H_stage));
            const stMR_HP = Math.max(1, Math.ceil(head(1.22, 0.95, 20.0, 300.0, P1_MR_HP, P2_MR_HP) / H_stage));
            const stC3_LP = (scheme === 'C3MR') ? Math.max(1, Math.ceil(head(1.12, 0.98, 44.097, 300.0, P1_C3_LP, P2_C3_LP) / H_stage)) : 0;
            const stC3_HP = (scheme === 'C3MR') ? Math.max(1, Math.ceil(head(1.12, 0.98, 44.097, 300.0, P1_C3_HP, P2_C3_HP) / H_stage)) : 0;
            const FG_stg = Math.max(1, Math.ceil(head(kF, ZF, MWF, T1_FG_K, P1_FG, P2_FG) / H_stage));
            const BOG_stg = Math.max(1, Math.ceil(head(1.31, ZB, MWB, T1_BOG_K, P1_BOG, P2_BOG) / H_stage));
            const FG_trains = FG_tph > 500 ? 2 : 1;

            // Split MR/C3 driver share
            const hMR = head(1.22, 0.95, 20.0, 300.0, P1_MR_LP, P2_MR_LP) + head(1.22, 0.95, 20.0, 300.0, P1_MR_HP, P2_MR_HP);
            const hC3 = head(1.12, 0.98, 44.097, 300.0, P1_C3_LP, P2_C3_LP) + head(1.12, 0.98, 44.097, 300.0, P1_C3_HP, P2_C3_HP);
            const MR_share = (scheme === 'C3MR') ? ((MR_tph / 3.6) * hMR) / (((MR_tph / 3.6) * hMR) + ((C3_tph / 3.6) * hC3)) : 1.0;
            const C3_share = (scheme === 'C3MR') ? 1.0 - MR_share : 0.0;
            const PMR = Pref_MW * MR_share;
            const PC3 = Pref_MW * C3_share;

            // Utilities
            const CW_m3h = Q_MW * CW_m3h_per_MWth;
            const HO_MW = LNG_th * HO_kW_per_tph / 1000.0;
            const IA_MR = (PMR + PC3) * IA_Nm3h_per_MWe;
            const IA_FG = WFG * IA_Nm3h_per_MWe;
            const IA_BOG = WBOG * IA_Nm3h_per_MWe;
            const N2 = LNG_th * N2_Nm3h_per_tph;
            const Flare_tph = FG_tph * (Flare_pct / 100.0);

            // NGL products
            const MWs = { CH4: 16.043, C2: 30.07, C3: 44.097, C4: 58.124, C5p: 72.0, N2: 28.014, CO2: 44.01 };
            function massfrac(comp_name) {
                const total_mass = composition.CH4 * MWs.CH4 + composition.C2 * MWs.C2 + composition.C3 * MWs.C3 + composition.C4 * MWs.C4 + composition.C5p * MWs.C5p + composition.N2 * MWs.N2 + composition.CO2 * MWs.CO2;
                return (composition[comp_name] * MWs[comp_name]) / total_mass;
            }
            const wC3 = massfrac('C3'), wC4 = massfrac('C4'), wC5 = massfrac('C5p');
            const LPG_tph = FG_tph * (wC3 * (R_C3_LPG / 100.0) + wC4 * (R_C4_LPG / 100.0));
            const COND_tph = FG_tph * (wC5 * (R_C5_COND / 100.0));

            // MCHE configuration
            let mche = "";
            if (mtpa < 3) mche = "1 x MCHE";
            else if (mtpa <= 6) mche = "2 x MCHE (parallel)";
            else mche = "2–3 x large MCHEs";

            return {
                LNG_th, FG_tph, MR_tph, C3_tph, BOG_tph, Q_MW, Pref_MW, WFG, WBOG, PMR, PC3,
                stMR_LP, stMR_HP, stC3_LP, stC3_HP, FG_stg, BOG_stg, FG_trains,
                CW_m3h, HO_MW, IA_MR, IA_FG, IA_BOG, N2, Flare_tph, mche, LPG_tph, COND_tph,
                gasProps: { k: kF, Z: ZF, MW: MWF, etap: etaPF }
            };
        }

        // Calculate for current MTPA
        const result = computeAt(MTPA);

        // Generate trend data for chart
        const trendData = {
            capacity: [],
            refrig_power: [],
            fg_power: [],
            bog_power: []
        };

        for (let mt = 0.5; mt <= 10.0; mt += 0.1) {
            const r = computeAt(parseFloat(mt.toFixed(1)));
            trendData.capacity.push(parseFloat(mt.toFixed(1)));
            trendData.refrig_power.push(r.Pref_MW);
            trendData.fg_power.push(r.WFG);
            trendData.bog_power.push(r.WBOG);
        }

        // Return comprehensive results
        const responseData = {
            // Main calculations
            main: result,

            // Gas properties (k, Z, MW, ηp)
            gasProperties: {
                k: result.gasProps.k.toFixed(3),
                Z: result.gasProps.Z.toFixed(3),
                MW: result.gasProps.MW.toFixed(2),
                etap: result.gasProps.etap.toFixed(2),
                formatted: `k=${result.gasProps.k.toFixed(3)}, Z=${result.gasProps.Z.toFixed(3)}, MW=${result.gasProps.MW.toFixed(2)}, ηp=${result.gasProps.etap.toFixed(2)}`
            },

            // Trend data for chart
            trends: trendData,

            // Configuration strings
            configurations: {
                mr: `LP ${result.stMR_LP} stg, HP ${result.stMR_HP} stg`,
                c3: result.stC3_LP ? `LP ${result.stC3_LP} stg, HP ${result.stC3_HP} stg` : "N/A",
                fg: `${result.FG_stg} stg, ${result.FG_trains} train(s)`,
                bog: `${result.BOG_stg} stg, 1 train`,
                mche: result.mche,
                note: result.FG_trains > 1 ?
                    "Trains > 1: Cold duty, Refrigeration power, MR/C3 split and FG/BOG driver powers are divided per train (values in parentheses)." :
                    "Single train — per‑train values not shown."
            },

            // Formatted values with per-train notation
            formatted: {
                lng: formatWithTrain(result.LNG_th, result.FG_trains),
                fg: formatWithTrain(result.FG_tph, result.FG_trains),
                lpg: formatWithTrain(result.LPG_tph, result.FG_trains),
                cond: formatWithTrain(result.COND_tph, result.FG_trains),
                bog: formatWithTrain(result.BOG_tph, result.FG_trains),
                q: formatWithTrain(result.Q_MW, result.FG_trains),
                pref: formatWithTrain(result.Pref_MW, result.FG_trains),
                split: `${(result.PMR).toFixed(2)} / ${(result.PC3).toFixed(2)}` +
                    (result.FG_trains > 1 ? ` ( ${(result.PMR / result.FG_trains).toFixed(2)} / ${(result.PC3 / result.FG_trains).toFixed(2)} /trn )` : ""),
                pfg: formatWithTrain(result.WFG, result.FG_trains),
                pbog: formatWithTrain(result.WBOG, result.FG_trains)
            },

            // Utilities
            utilities: {
                cw: result.CW_m3h.toFixed(2),
                ho: result.HO_MW.toFixed(2),
                ia_mr: result.IA_MR.toFixed(2),
                ia_fg: result.IA_FG.toFixed(2),
                ia_bog: result.IA_BOG.toFixed(2),
                n2: result.N2.toFixed(2),
                flare: result.Flare_tph.toFixed(2)
            }
        };

        function formatWithTrain(value, trains) {
            const main = value.toFixed(2);
            const perTrain = trains > 1 ? ` ( ${(value / trains).toFixed(2)} /trn )` : "";
            return main + perTrain;
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(responseData)
        };

    } catch (err) {
        console.error('FLNG Sizing calculation error:', {
            error: err.message,
            stack: err.stack,
            body: event.body
        });
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: "Server error during FLNG sizing calculation",
                details: String(err?.message || err),
                timestamp: new Date().toISOString()
            })
        };
    }
};  