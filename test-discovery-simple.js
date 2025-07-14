// Simple test for the deployed discovery-orchestrator function

async function testDiscoveryOrchestrator() {
  console.log('Testing discovery orchestrator function...\n');
  
  try {
    // Test: GitHub trending only (faster test)
    console.log('=== Testing GitHub Trending Discovery ===');
    const response = await fetch('https://ktpdhiudpwckpyqmeitc.supabase.co/functions/v1/discovery-orchestrator?sources=github_trending', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Request failed with status ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    console.log('Discovery result:');
    console.log('Success:', result.success);
    console.log('Totals:', result.totals);
    console.log('Results by source:');
    
    for (const sourceResult of result.results || []) {
      console.log(`  ${sourceResult.source_name}: ${sourceResult.discovered} discovered, ${sourceResult.inserted} new, ${sourceResult.existing} existing`);
      if (sourceResult.errors.length > 0) {
        console.log(`    Errors: ${sourceResult.errors.length}`);
      }
    }
    
    console.log('\n=== Discovery Test Complete ===');
    console.log(`Total repos discovered: ${result.totals?.discovered || 0}`);
    console.log(`New repos inserted: ${result.totals?.inserted || 0}`);
    
    return result;
    
  } catch (error) {
    console.error('Discovery test failed:', error.message);
    return null;
  }
}

// Run the test
testDiscoveryOrchestrator();