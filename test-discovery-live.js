// Test the deployed discovery-orchestrator function
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Test configuration
const supabaseUrl = 'https://ktpdhiudpwckpyqmeitc.supabase.co';
const functionUrl = `${supabaseUrl}/functions/v1/discovery-orchestrator`;

async function testDiscoveryOrchestrator() {
  console.log('Testing discovery orchestrator function...\n');
  
  try {
    // Test 1: GitHub trending only (faster test)
    console.log('=== Test 1: GitHub Trending Only ===');
    const trendingResponse = await fetch(`${functionUrl}?sources=github_trending`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!trendingResponse.ok) {
      throw new Error(`Trending test failed: ${trendingResponse.status}`);
    }
    
    const trendingResult = await trendingResponse.json();
    console.log('Trending discovery result:', JSON.stringify(trendingResult, null, 2));
    
    // Test 2: All sources (comprehensive test)
    console.log('\n=== Test 2: All Discovery Sources ===');
    const allResponse = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!allResponse.ok) {
      throw new Error(`All sources test failed: ${allResponse.status}`);
    }
    
    const allResult = await allResponse.json();
    console.log('All sources discovery result:', JSON.stringify(allResult, null, 2));
    
    // Success summary
    console.log('\n=== Discovery System Test Complete ===');
    console.log(`Trending test: ${trendingResult.totals.discovered} repos discovered, ${trendingResult.totals.inserted} new`);
    console.log(`All sources test: ${allResult.totals.discovered} repos discovered, ${allResult.totals.inserted} new`);
    
  } catch (error) {
    console.error('Discovery test failed:', error);
    process.exit(1);
  }
}

// Run the test
testDiscoveryOrchestrator();